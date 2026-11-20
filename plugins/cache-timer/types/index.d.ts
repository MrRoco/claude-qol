// The state contract of the cache-timer mod: what it keeps in `$.state` for
// the conversation. Times, token counts and a cost only; `/clear` wipes it.

/** The lifetime the last cache write of the main chat got. */
export type CacheTtl = "5m" | "1h";

/** The outcome of the last Keep warm press. */
export type CachePing = {
  /** ms, from $.clock, when the ping was sent */
  at: number;
  /** what the press cost in US dollars; null when unknown */
  costUsd: number | null;
  ok: boolean;
  /** why it got no reply, when `ok` is false */
  reason?: string;
};

declare module "claude-code" {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    "cache-timer": {
      /** ms, from $.clock: start of the main chat's last request or ping */
      lastRequestAt: number | null;
      /** lifetime of the last write; null until the first answer */
      ttl: CacheTtl | null;
      /** last measured context size, in tokens */
      tokens: number | null;
      /** a Keep warm request is in flight */
      warming: boolean;
      lastPing: CachePing | null;
      /** the person pressed Hide on the cold row */
      hiddenUntilTurn: boolean;
    };
  }
}
