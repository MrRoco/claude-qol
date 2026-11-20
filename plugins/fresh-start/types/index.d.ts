// The state contract of the fresh-start mod: what it keeps in `$.state` for
// the conversation. `/clear` wipes it, which is the reset the new chat wants.
// The handoff text itself is never kept here.

/** Where the handoff flow stands. */
export type Step = 'idle' | 'offer' | 'writing' | 'saving' | 'choose' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    'fresh-start': {
      step: Step
      /** last measured context size, in tokens */
      tokens: number | null
      /** the offer was dismissed in this conversation */
      dismissed: boolean
      /** ms, from $.clock, when writing began */
      startedAt: number | null
      /** project-relative path of the saved handoff */
      file: string | null
      /** short reason when step is 'failed' */
      error: string | null
    }
  }
}
