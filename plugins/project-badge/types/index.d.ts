// The state contract of the project-badge mod: the badge drawn by the prompt.
// The context block for Claude is kept only in the running mod's memory.

/** e.g. "DDEV · MODX 3.0 · PHP 8.2"; null when nothing was recognised. */
export type Badge = string | null;

declare module "claude-code" {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    "project-badge": {
      badge: Badge;
    };
  }
}
