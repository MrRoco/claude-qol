// The state contract of the lesson-saver mod: what it keeps in `$.state` for
// the conversation. `/clear` wipes it. Claude's last answer is never kept
// here, only in the running mod's memory.

declare module "claude-code" {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    "lesson-saver": {
      /** the drafted rule on offer, and which CLAUDE.md the check suggested */
      lesson: { rule: string; suggested: "project" | "global" } | null;
      /** the row shows the rule in a text field */
      editing: boolean;
      /** a Save press is reading or writing a CLAUDE.md */
      saving: boolean;
    };
  }
}

/** Which CLAUDE.md a rule goes to: the project's or the person's global one. */
export type Target = "project" | "global";
