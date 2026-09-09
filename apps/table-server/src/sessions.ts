/**
 * Sessions: challenge-response authentication, per-connection accounting,
 * and rate limiting. Hole cards and payment requests go only to the
 * authenticated connection of the intended player (docs/05, docs/07).
 */

import type { WebSocket } from "ws";
import { type AuthChallenge, generateKeyPair } from "@fiber-poker/protocol";

export interface Session {
  sessionId: string;
  playerId: string; // pubkey hex
  socket: WebSocket;
  connectedAt: number;
  lastSeen: number;
  /** Token bucket for rate limiting. */
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  constructor(
    private readonly perSecond: number,
    private readonly burst = 20,
  ) {}

  allow(session: Session, now: number): boolean {
    const elapsed = (now - session.lastRefill) / 1000;
    session.tokens = Math.min(this.burst, session.tokens + elapsed * this.perSecond);
    session.lastRefill = now;
    if (session.tokens < 1) return false;
    session.tokens -= 1;
    return true;
  }
}

export class SessionManager {
  private bySocket = new Map<WebSocket, Session>();
  private byPlayer = new Map<string, Session>();
  private pending = new Map<WebSocket, { pubkey: string; challenge: AuthChallenge; createdAt: number }>();

  createPending(socket: WebSocket, pubkey: string, challenge: AuthChallenge): void {
    this.pending.set(socket, { pubkey, challenge, createdAt: Date.now() });
  }

  takePending(socket: WebSocket): { pubkey: string; challenge: AuthChallenge; createdAt: number } | undefined {
    const p = this.pending.get(socket);
    this.pending.delete(socket);
    return p;
  }

  register(socket: WebSocket, playerId: string): Session {
    // A reconnecting player replaces their old socket.
    const old = this.byPlayer.get(playerId);
    if (old && old.socket !== socket) {
      this.bySocket.delete(old.socket);
    }
    const session: Session = {
      sessionId: sessionToken(),
      playerId,
      socket,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      tokens: 20,
      lastRefill: Date.now(),
    };
    this.bySocket.set(socket, session);
    this.byPlayer.set(playerId, session);
    return session;
  }

  get(socket: WebSocket): Session | undefined {
    return this.bySocket.get(socket);
  }

  getByPlayer(playerId: string): Session | undefined {
    return this.byPlayer.get(playerId);
  }

  remove(socket: WebSocket): Session | undefined {
    const s = this.bySocket.get(socket);
    if (s) {
      this.bySocket.delete(socket);
      if (this.byPlayer.get(s.playerId) === s) this.byPlayer.delete(s.playerId);
    }
    return s;
  }

  isOnline(playerId: string): boolean {
    return this.byPlayer.has(playerId);
  }

  onlinePlayers(): string[] {
    return [...this.byPlayer.keys()];
  }

  onlineSessions(): Session[] {
    return [...this.bySocket.values()];
  }
}

function sessionToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export { generateKeyPair };
