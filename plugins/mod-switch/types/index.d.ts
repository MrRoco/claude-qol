// The state contract of the mod-switch mod: what it keeps in `$.state` for
// the session. Saved sets live in `$.store` under `sets`, not here.

/** Where a mod was installed, as the `claude` CLI reports it. */
export type ModScope = "user" | "project" | "local" | "session";

/** Why a row cannot be switched from the pane. */
export type ModLock = "managed" | "session" | "self" | "ambiguous";

/** One installed mod, as the pane lists it. */
export type ModRow = {
  /** `name@marketplace`, or `name@inline` for a `--plugin-dir` mod */
  id: string;
  name: string;
  marketplace: string | null;
  version: string | null;
  description: string | null;
  scope: ModScope | null;
  isOn: boolean;
  lock: ModLock | null;
  /** last problem seen for it in this session; the host offers no source yet */
  problem: string | null;
};

declare module "claude-code" {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    "mod-switch": {
      mods: {
        id: string;
        name: string;
        marketplace: string | null;
        version: string | null;
        description: string | null;
        scope: "user" | "project" | "local" | "session" | null;
        isOn: boolean;
        lock: "managed" | "session" | "self" | "ambiguous" | null;
        problem: string | null;
      }[];
      isLoading: boolean;
      /** a switch happened since this session loaded its plugins */
      needsReload: boolean;
      /** the mod being switched right now */
      busyId: string | null;
    };
  }
}
