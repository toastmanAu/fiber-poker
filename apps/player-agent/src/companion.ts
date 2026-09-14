/** Optional loopback browser transport. No signing, poker decisions or settlement.
 * Its configured gateway is supplied by the local operator (a simulator in tests).
 * One browser connection replaces a headless agent, not the table protocol.
 */
import { WebSocket, WebSocketServer } from "ws";
import { ensureCapacity, type FiberGateway } from "@fiber-poker/fiber-adapter";

export interface CompanionConfig {
  tableUrl: string;
  playerId: string;
  gateway: FiberGateway;
  port?: number;
  allowedOrigins: string[];
  /** Explicit local operator opt-in. Defaults to observing requests only. */
  payInvoices?: boolean;
}
export class PlayerCompanion {
  private listener: WebSocketServer | null = null;
  private browser: WebSocket | null = null;
  private upstream: WebSocket | null = null;
  private peer = "";
  /** The table's FIBER node pubkey (from the upstream WELCOME) — capacity
   *  target for auto-provisioning when a payment would outrun the pool. */
  private tableFiberPeer = "";
  private payments = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(private readonly config: CompanionConfig) {}
  get port(): number {
    const address = this.listener?.address();
    return address && typeof address !== "string" ? address.port : 0;
  }
  async start(): Promise<void> {
    this.peer = await this.config.gateway.nodePubkey();
    this.listener = new WebSocketServer({
      host: "127.0.0.1",
      port: this.config.port ?? 8788,
      maxPayload: 64 * 1024,
      verifyClient: ({ origin }, done) => {
        if (!this.config.allowedOrigins.includes(origin))
          return done(false, 403, "Origin not allowed");
        if (this.browser?.readyState === WebSocket.OPEN)
          return done(false, 409, "Browser already connected");
        done(true);
      },
    });
    this.listener.on("connection", (browser) => this.attach(browser));
    await new Promise<void>((resolve, reject) => {
      this.listener!.once("listening", resolve);
      this.listener!.once("error", reject);
    });
  }
  private attach(browser: WebSocket): void {
    if (this.browser?.readyState === WebSocket.OPEN) {
      browser.close(1008, "Browser already connected");
      return;
    }
    this.browser = browser;
    let upstream: WebSocket | null = null;
    let authenticated = false;
    const queued: string[] = [];
    const timer = setTimeout(
      () => browser.close(1008, "Authentication timeout"),
      15000,
    );
    const fail = (code: string, detail: string) => {
      this.send(browser, "ERROR", { code, detail });
      browser.close(1008, code);
    };
    browser.on("message", (data) => {
      let message: { type: string; payload: Record<string, unknown> };
      try {
        message = JSON.parse(data.toString());
        if (!message.payload || typeof message.payload !== "object")
          throw new Error();
      } catch {
        fail("COMPANION_BAD_MESSAGE", "Invalid poker message.");
        return;
      }
      if (["HELLO", "AUTH_RESPONSE"].includes(message.type) && message.payload.pubkey !== this.config.playerId) {
        fail("COMPANION_KEY_MISMATCH", "The companion only serves its configured poker identity.");
        return;
      }
      if (message.type === "HELLO") authenticated = false;
      if (!upstream) {
        if (
          message.type !== "HELLO" ||
          message.payload.pubkey !== this.config.playerId
        ) {
          fail(
            "COMPANION_KEY_MISMATCH",
            "Choose the companion's matching .session.json poker identity file.",
          );
          return;
        }
        upstream = new WebSocket(this.config.tableUrl, {
          maxPayload: 1024 * 1024,
          handshakeTimeout: 10000,
        });
        this.upstream = upstream;
        const remote = upstream;
        remote.on("open", () => {
          for (const item of queued) remote.send(item);
          queued.length = 0;
        });
        remote.on("message", (raw) => {
          let incoming: { type: string; payload: Record<string, unknown> };
          try {
            incoming = JSON.parse(raw.toString());
          } catch {
            remote.close(1002, "Invalid table message");
            return;
          }
          if (incoming.type === "WELCOME") {
            authenticated = true;
            clearTimeout(timer);
            const fiberPeer = (incoming.payload as { fiberPeerPubkey?: string }).fiberPeerPubkey;
            if (fiberPeer) this.tableFiberPeer = fiberPeer;
          }
          if (browser.readyState === WebSocket.OPEN)
            browser.send(raw.toString());
          if (incoming.type === "WELCOME")
            this.send(browser, "COMPANION_STATUS", {
              status: this.config.payInvoices ? "READY" : "OBSERVE_ONLY",
            });
          if (authenticated && incoming.type === "PAYMENT_REQUIRED")
            this.pay(incoming.payload, browser);
        });
        remote.on("error", () =>
          fail(
            "COMPANION_TABLE_UNAVAILABLE",
            "The companion could not connect to the table.",
          ),
        );
        remote.on("close", () =>
          browser.close(1012, "Table connection closed"),
        );
      }
      if (message.type === "JOIN_TABLE") {
        if (!authenticated) {
          fail("COMPANION_NOT_AUTHENTICATED", "Authenticate before joining.");
          return;
        }
        message.payload = { ...message.payload, fiberPeerPubkey: this.peer };
      }
      const serialized = JSON.stringify(message);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(serialized);
      else if (
        upstream.readyState === WebSocket.CONNECTING &&
        queued.length < 16
      )
        queued.push(serialized);
      else
        fail(
          "COMPANION_UNAVAILABLE",
          "The companion is reconnecting to the table.",
        );
    });
    browser.on("error", () => browser.close());
    browser.on("close", () => {
      clearTimeout(timer);
      if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
      else upstream?.close();
      if (this.browser === browser) this.browser = null;
      if (this.upstream === upstream) this.upstream = null;
    });
  }
  private pay(payload: Record<string, unknown>, browser: WebSocket): void {
    if (
      this.stopped ||
      !this.config.payInvoices ||
      payload.direction !== "PLAYER_TO_TABLE" ||
      typeof payload.invoiceAddress !== "string" ||
      typeof payload.obligationId !== "string"
    )
      return;
    const id = payload.obligationId;
    if (this.payments.has(id)) return;
    this.send(browser, "COMPANION_STATUS", {
      status: "PAYMENT_SUBMITTING",
      obligationId: id,
    });
    // Start after insertion so even synchronous gateway failures are retryable.
    const task = Promise.resolve().then(async () => {
      const amount = BigInt(String(payload.amountShannons ?? "0"));
      const attempt = async (): Promise<void> => {
        if (!this.config.gateway.payInvoice)
          throw new Error("Invoice payment unavailable");
        await this.config.gateway.payInvoice(payload.invoiceAddress as string);
      };
      try {
        await attempt();
        this.send(browser, "COMPANION_STATUS", {
          status: "PAYMENT_SUBMITTED",
          obligationId: id,
        });
      } catch (error) {
        // Insufficient player-side capacity: provision toward the table and
        // retry once before reporting failure (capacity.ts).
        const insufficient = /insufficient/i.test(String(error));
        if (insufficient && this.tableFiberPeer) {
          try {
            await ensureCapacity(this.config.gateway, this.tableFiberPeer, {
              min: amount > 0n ? amount * 2n : 50n * 100_000_000n,
              openFunding: 600n * 100_000_000n,
            });
            await attempt();
            this.send(browser, "COMPANION_STATUS", {
              status: "PAYMENT_SUBMITTED",
              obligationId: id,
            });
            return;
          } catch {
            /* fall through to failure */
          }
        }
        this.send(browser, "COMPANION_STATUS", {
          status: "PAYMENT_FAILED",
          obligationId: id,
        });
        this.payments.delete(id);
      }
    });
    this.payments.set(id, task);
    if (this.payments.size > 512) {
      const oldest = this.payments.keys().next().value!;
      void this.payments.get(oldest)!.then(() => this.payments.delete(oldest));
    }
  }
  private send(
    socket: WebSocket,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type, payload }));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.browser?.terminate();
    this.upstream?.terminate();
    await new Promise<void>((resolve) =>
      this.listener ? this.listener.close(() => resolve()) : resolve(),
    );
  }
}
