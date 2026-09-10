/**
 * FNN v0.9.0 JSON-RPC client.
 *
 * Verified against the v0.9.0 generated RPC reference and serde types
 * (see docs/fnn-compat.md):
 *  - JSON-RPC 2.0 over HTTP POST; `params` is a one-element array wrapping
 *    the request object.
 *  - u64/u128 numbers are 0x-prefixed hex strings; amounts in shannons.
 *  - pubkeys are 33-byte hex WITHOUT 0x.
 *  - channel state names are PascalCase ("ChannelReady", "Closed", ...).
 *  - invoice creation is `new_invoice` (not create_invoice); closing is
 *    `shutdown_channel` (not close_channel); paying an invoice is
 *    `send_payment { invoice }`.
 *  - payment status: "Created" | "Inflight" | "Success" | "Failed".
 */

export class FiberRpcError extends Error {
  constructor(readonly code: number | string, message: string) {
    super(`fiber rpc ${code}: ${message}`);
  }
}

export interface FiberRpcOptions {
  url: string;
  /** Auth token (Biscuit) if the node requires one. Server-side only! */
  authToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function call<T>(opts: FiberRpcOptions, method: string, params: object): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method, params: [params] });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new FiberRpcError(res.status, `http ${res.status} for ${method}`);
  }
  const json = (await res.json()) as { result?: T; error?: { code: number | string; message: string } };
  if (json.error) throw new FiberRpcError(json.error.code, json.error.message);
  return json.result as T;
}

// --- canonical wire helpers -------------------------------------------------
import { hexAmount, parseAmount } from "./hex.ts";
export { hexAmount, parseAmount };

// --- typed method wrappers (v0.9.0 names) -----------------------------------

export interface NodeInfo {
  node_name: string;
  node_pubkey: string;
  [k: string]: unknown;
}

export interface FiberChannel {
  channel_id: string;
  peer_pubkey: string;
  state_name: string;
  local_balance: string;
  remote_balance: string;
  offered_tlc_balance: string;
  received_tlc_balance: string;
  is_public: boolean;
  is_one_way: boolean;
  [k: string]: unknown;
}

export interface FiberInvoice {
  invoice_address: string;
  invoice: { data: { payment_hash: string; amount?: string; currency?: string; [k: string]: unknown }; status?: string; [k: string]: unknown };
}

export interface FiberPayment {
  payment_hash: string;
  status: "Created" | "Inflight" | "Success" | "Failed";
  failed_error?: string;
  payment_preimage?: string;
  [k: string]: unknown;
}

const CHANNEL_READY = "ChannelReady";

export class FiberRpcClient {
  constructor(private readonly opts: FiberRpcOptions) {}

  nodeInfo(): Promise<NodeInfo> {
    return call(this.opts, "node_info", {});
  }

  connectPeer(address: string): Promise<{ peer_id: string }> {
    return call(this.opts, "connect_peer", { address });
  }

  openChannel(req: {
    peer_id: string;
    funding_amount: bigint;
    public?: boolean;
    one_way?: boolean;
    funding_udt_type_script?: object;
    shutdown_script?: string;
    fee_rate?: bigint;
  }): Promise<{ temporary_channel_id: string }> {
    return call(this.opts, "open_channel", {
      ...req,
      funding_amount: hexAmount(req.funding_amount),
    });
  }

  acceptChannel(req: { temporary_channel_id: string; funding_amount?: bigint }): Promise<{ channel_id: string }> {
    return call(this.opts, "accept_channel", {
      temporary_channel_id: req.temporary_channel_id,
      ...(req.funding_amount !== undefined ? { funding_amount: hexAmount(req.funding_amount) } : {}),
    });
  }

  listChannels(req: { pubkey?: string; include_closed?: boolean; only_pending?: boolean } = {}): Promise<{ channels: FiberChannel[] }> {
    return call(this.opts, "list_channels", req);
  }

  shutdownChannel(req: { channel_id: string; close_script?: string; fee_rate?: bigint; force?: boolean }): Promise<null> {
    return call(this.opts, "shutdown_channel", {
      ...req,
      ...(req.fee_rate !== undefined ? { fee_rate: hexAmount(req.fee_rate) } : {}),
    });
  }

  newInvoice(req: {
    amount: bigint;
    currency?: "Fibb" | "Fibt" | "Fibd";
    payment_preimage?: string;
    payment_hash?: string;
    expiry?: bigint;
    udt_type_script?: object;
    description?: string;
  }): Promise<FiberInvoice> {
    return call(this.opts, "new_invoice", {
      ...req,
      amount: hexAmount(req.amount),
      ...(req.expiry !== undefined ? { expiry: hexAmount(req.expiry) } : {}),
    });
  }

  sendPayment(req: { invoice?: string; target_pubkey?: string; amount?: bigint; payment_hash?: string; custom_records?: Record<string, string> }): Promise<FiberPayment> {
    return call(this.opts, "send_payment", {
      ...req,
      ...(req.amount !== undefined ? { amount: hexAmount(req.amount) } : {}),
    });
  }

  getPayment(req: { payment_hash: string }): Promise<FiberPayment> {
    return call(this.opts, "get_payment", req);
  }

  /** Payee-side invoice lookup: status "Open" | "Received" | "Paid" | "Cancelled" | "Expired". */
  getInvoice(req: { payment_hash: string }): Promise<{ invoice_address: string; invoice: FiberInvoice["invoice"]; status: string }> {
    return call(this.opts, "get_invoice", req);
  }

  /** Hold-invoice settlement: reveal the preimage to complete the payment. */
  settleInvoice(req: { payment_hash: string; payment_preimage: string }): Promise<null> {
    return call(this.opts, "settle_invoice", req);
  }

  /** Cancel an open/received invoice (payer funds are released). */
  cancelInvoice(req: { payment_hash: string }): Promise<null> {
    return call(this.opts, "cancel_invoice", req);
  }

  /** Convenience: wait until the channel with `peerPubkey` reports ChannelReady. */
  async waitChannelReady(peerPubkey: string, timeoutMs = 120_000, pollMs = 500): Promise<FiberChannel> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { channels } = await this.listChannels({ pubkey: peerPubkey });
      const ready = channels.find((c) => c.state_name === CHANNEL_READY);
      if (ready) return ready;
      if (Date.now() > deadline) throw new Error(`channel with ${peerPubkey} not ChannelReady before timeout`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
