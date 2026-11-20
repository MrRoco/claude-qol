// The state contract of the privacy-mask mod: one switch, kept by the host for
// the session. It survives a reload and `/clear`; only `/mask` changes it.
// No transcript text is ever kept here.

/** The label the prompt footer shows while masking is on. */
export type ModeLabel = "masked";

declare module "claude-code" {
  interface PluginState {
    // Each key spelled out: `claude plugin validate` reads the names here.
    "privacy-mask": {
      /** masking is switched on */
      isOn: boolean;
    };
  }
}
