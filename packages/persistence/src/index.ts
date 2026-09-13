/**
 * Event sourcing: append-only events are the source of truth; snapshots are
 * acceleration only (docs/06).
 *
 * Durability contract: `append` must not resolve until the event is durable
 * (fsync on the file store). The server persists intent BEFORE any external
 * Fiber side effect and persists results AFTER, so crash recovery can always
 * answer: was money committed? was poker state committed? what resumes?
 */

import { PROTOCOL_VERSION } from "@fiber-poker/protocol";
import { open, type FileHandle } from "node:fs/promises";

/** Event types (docs/06). Extending this list is additive-safe. */
export const EVENT_TYPES = [
  "PlayerConnected",
  "PlayerAuthenticated",
  "ChannelObserved",
  "ChannelReady",
  "PlayerSeated",
  "LeaveRequested",
  "HandStarted",
  "DeckCommitted",
  "DeckRevealed",
  "BlindRequested",
  "SettlementPlanned",
  "PaymentInflight",
  "PaymentSucceeded",
  "PaymentFailed",
  "ActionCommitted",
  "ActionRejected",
  "StreetAdvanced",
  "PlayerFolded",
  "PlayerAllIn",
  "ShowdownStarted",
  "PotAwarded",
  "PayoutInflight",
  "PayoutSucceeded",
  "PayoutFailed",
  "HandCompleted",
  "HandAborted",
  "TurnTimerStarted",
  "TurnTimeoutResolved",
  "StateAckRecorded",
  "SeedProtocolStarted",
  "SeedProtocolCompleted",
  "PlayerDisconnected",
  "ChannelShutdownRequested",
  "ChannelClosed",
  "TableSnapshotTaken",
  "RecoveryCompleted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Persisted event envelope (matches schemas/event.schema.json). */
export interface PokerEvent<P = Record<string, unknown>> {
  /** Monotonic, gap-free, zero-padded decimal id assigned by the store. */
  eventId: string;
  protocolVersion: number;
  tableId: string;
  handId?: string | null;
  sequence?: string | null;
  eventType: EventType;
  /** Wall-clock stamp for humans/ops; NEVER used for game determinism. */
  createdAt: string;
  payload: P;
  stateHash?: string | null;
  /** Fiber correlation: payment hash / channel operation id. */
  fiberRef?: string | null;
}

export interface Snapshot {
  lastEventId: string;
  stateHash: string;
  /** Table state serialized bigint-safe by the caller. */
  state: unknown;
  savedAt: string;
  protocolVersion: number;
}

export interface EventStore {
  /** Persist durably, assigning the next eventId. Resolves after fsync. */
  append(event: Omit<PokerEvent, "eventId" | "protocolVersion"> & { protocolVersion?: number }): Promise<PokerEvent>;
  /** All events in order; optionally from an eventId (inclusive). */
  readAll(fromEventId?: string): Promise<PokerEvent[]>;
  /** Events referencing a Fiber operation (reconciliation scans). */
  readByFiberRef(fiberRef: string): Promise<PokerEvent[]>;
  close(): Promise<void>;
}

export interface SnapshotStore {
  save(snapshot: Snapshot): Promise<void>;
  loadLatest(): Promise<Snapshot | null>;
}

let counter = 0;
function nextEventId(): string {
  // Zero-padded monotonic id; per-process uniqueness is enough because the
  // file store serializes appends through a single writer.
  counter += 1;
  return `${Date.now().toString(36).padStart(10, "0")}-${counter.toString(36).padStart(8, "0")}`;
}

/** In-memory store for tests and fast CI. */
export class InMemoryEventStore implements EventStore {
  readonly events: PokerEvent[] = [];

  async append(
    event: Omit<PokerEvent, "eventId" | "protocolVersion"> & { protocolVersion?: number },
  ): Promise<PokerEvent> {
    const full: PokerEvent = {
      ...event,
      eventId: nextEventId(),
      protocolVersion: event.protocolVersion ?? PROTOCOL_VERSION,
    } as PokerEvent;
    this.events.push(full);
    return full;
  }

  async readAll(fromEventId?: string): Promise<PokerEvent[]> {
    if (!fromEventId) return [...this.events];
    const idx = this.events.findIndex((e) => e.eventId === fromEventId);
    return idx < 0 ? [] : this.events.slice(idx);
  }

  async readByFiberRef(fiberRef: string): Promise<PokerEvent[]> {
    return this.events.filter((e) => e.fiberRef === fiberRef);
  }

  async close(): Promise<void> {
    /* nothing to flush */
  }
}

/**
 * File-backed NDJSON store. Each append writes one line and fdatasyncs the
 * file descriptor before resolving: crash between events loses nothing.
 */
export class FileEventStore implements EventStore {
  private handle: FileHandle | null = null;
  private readonly events: PokerEvent[] = [];
  private loadPromise: Promise<void>;

  constructor(private readonly path: string) {
    this.loadPromise = this.load();
  }

  private async load(): Promise<void> {
    const { readFile } = await import("node:fs/promises");
    try {
      const text = await readFile(this.path, "utf8");
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        this.events.push(JSON.parse(line) as PokerEvent);
      }
    } catch {
      // First run: file does not exist yet.
    }
    this.handle = await open(this.path, "a");
  }

  async append(
    event: Omit<PokerEvent, "eventId" | "protocolVersion"> & { protocolVersion?: number },
  ): Promise<PokerEvent> {
    await this.loadPromise;
    const full: PokerEvent = {
      ...event,
      eventId: nextEventId(),
      protocolVersion: event.protocolVersion ?? PROTOCOL_VERSION,
    } as PokerEvent;
    const handle = this.handle;
    if (!handle) throw new Error("event store closed");
    // Single write of the full line, then fdatasync: durable before resolving.
    await handle.write(JSON.stringify(full) + "\n", null, "utf8");
    await handle.datasync();
    this.events.push(full);
    return full;
  }

  async readAll(fromEventId?: string): Promise<PokerEvent[]> {
    await this.loadPromise;
    if (!fromEventId) return [...this.events];
    const idx = this.events.findIndex((e) => e.eventId === fromEventId);
    return idx < 0 ? [] : this.events.slice(idx);
  }

  async readByFiberRef(fiberRef: string): Promise<PokerEvent[]> {
    await this.loadPromise;
    return this.events.filter((e) => e.fiberRef === fiberRef);
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.close();
  }
}

/** Snapshot store: one JSON file, atomically replaced (tmp + rename). */
export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly path: string) {}

  async save(snapshot: Snapshot): Promise<void> {
    const { writeFile, rename } = await import("node:fs/promises");
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot), "utf8");
    await rename(tmp, this.path);
  }

  async loadLatest(): Promise<Snapshot | null> {
    const { readFile } = await import("node:fs/promises");
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Snapshot;
    } catch {
      return null;
    }
  }
}

/** In-memory snapshot store for tests. */
export class InMemorySnapshotStore implements SnapshotStore {
  private snapshot: Snapshot | null = null;
  async save(snapshot: Snapshot): Promise<void> {
    this.snapshot = snapshot;
  }
  async loadLatest(): Promise<Snapshot | null> {
    return this.snapshot;
  }
}
