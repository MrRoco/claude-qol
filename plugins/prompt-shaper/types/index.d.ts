// The state contract of the prompt-shaper mod: where a shaping run stands.
// The caught prompt and the brief are never kept here, only in the running
// mod's memory until the run ends.

/**
 * Where a shaping run stands. `held` is the read-only row shown when the
 * prompt box refused the text, so it is never lost.
 */
export type Step = "idle" | "reading" | "asking" | "writing" | "held";

declare module "claude-code" {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    "prompt-shaper": {
      step: Step;
      /** the questions of the current run, at most three */
      questions: string[];
      /** the question being asked */
      index: number;
      /** one per question asked so far; null when skipped */
      answers: (string | null)[];
    };
  }
}
