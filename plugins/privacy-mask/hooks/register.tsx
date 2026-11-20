import { update } from "claude-code";
import type {
  EngineInterface,
  PluginOptions,
  Register,
  RenderElement,
  RenderInput,
} from "claude-code";

import { createMasker } from "./patterns";
import type { Masker } from "./patterns";
import type { ModeLabel } from "../types";

type Engine = EngineInterface;

const COMMAND = "mask";
const COMMAND_DESCRIPTION =
  "Switch on-screen masking of personal details and secrets";
const MODE_LABEL: ModeLabel = "masked";

const TEXT_ON =
  "Masking is on. Rows printed before now may still show unmasked.";
const TEXT_OFF = "Masking is off.";
const TEXT_FAILED = "Could not switch masking.";
// Drawn in place of a row whose masking failed: never the row itself.
const PLACEHOLDER = "█ masked content could not be drawn";

// Deeper than any tool input or result seen; past it the row is not trusted
// to be masked, so it fails closed.
const MAX_DEPTH = 32;
// Image data in a Read result: masking it hides nothing and could break it.
const SKIPPED_KEYS = new Set(["base64"]);

const IS_ON = { plugin: "privacy-mask", key: "isOn" } as const;

// The last switch value this module read or wrote. A `.catch` handler uses it
// to decide: only a known `false` lets the engine's own drawing through.
// `null` (not read yet) fails closed like `true`.
let lastKnownOn: boolean | null = null;
// The value `/mask` last wrote. `$.state` keeps the switch over a reload; this
// keeps it if the host ever drops session state at `/clear` (the process, and
// so this module, goes on there). Never set from a read.
let toggledOn: boolean | null = null;

/** The switch: the stored value, else what `/mask` last set, else off. */
const effectiveOn = (stored: boolean | undefined): boolean =>
  stored === undefined ? toggledOn === true : stored;

const readNames = (options: PluginOptions | undefined): unknown[] => {
  const value = options?.names;

  return Array.isArray(value) ? value : [];
};

/** Masks every string in a plain value, keeping its shape and other values. */
const maskValue = (value: unknown, maskText: Masker, depth = 0): unknown => {
  if (typeof value === "string") {
    return maskText(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    throw new Error("value too deep to mask");
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, maskText, depth + 1));
  }

  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    result[key] = SKIPPED_KEYS.has(key)
      ? item
      : maskValue(item, maskText, depth + 1);
  }

  return result;
};

const readIsOn = async ($: Engine): Promise<boolean> => {
  // Read through `$.state.get`, so a toggle redraws every hooked row.
  const { value } = await $.state.get(IS_ON);
  const isOn = effectiveOn(value);
  lastKnownOn = isOn;

  return isOn;
};

/** The fail-closed drawing: a dim line, never the row's own content. */
const placeholder = ($: Engine, e: RenderInput): RenderElement => {
  const { Text } = $.ui.resolve(e);

  return <Text dimColor>{PLACEHOLDER}</Text>;
};

export const register: Register = (on, options) => {
  // Compiled once per load; a change to the names list reloads the module.
  const maskText = createMasker(readNames(options));

  // Fires at the session's start and at every reload: it only registers the
  // command, never touches the switch.
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: COMMAND_DESCRIPTION,
      });
    } catch {
      // The command is missing this session; masking hooks still work.
    }

    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    const isOn = await update($, IS_ON, (value) => !effectiveOn(value));
    toggledOn = isOn;
    lastKnownOn = isOn;

    // For the person alone: the model never reads this reply.
    return {
      text: isOn ? TEXT_ON : TEXT_OFF,
      isTextDisplayOnly: true as const,
    };
  }).catch(() => ({ text: TEXT_FAILED, isTextDisplayOnly: true as const }));

  // Each masking hook: off, the row goes on untouched; on, its text props are
  // masked before the engine draws them. A failure while on (or unknown)
  // draws the placeholder, never the row.
  on("ui.render", { component: "UserMessage" }, async ($, e, next) =>
    (await readIsOn($))
      ? next({ ...e, props: { ...e.props, text: maskText(e.props.text) } })
      : next(e),
  ).catch(($, e, next) =>
    lastKnownOn === false ? next(e) : placeholder($, e),
  );

  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) =>
    (await readIsOn($))
      ? next({ ...e, props: { ...e.props, text: maskText(e.props.text) } })
      : next(e),
  ).catch(($, e, next) =>
    lastKnownOn === false ? next(e) : placeholder($, e),
  );

  // Input and output keep their shape: only string values change.
  on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
    if (!(await readIsOn($))) {
      return next(e);
    }

    const props = { ...e.props, input: maskValue(e.props.input, maskText) };

    if (e.props.output !== undefined) {
      props.output = maskValue(e.props.output, maskText);
    }

    return next({ ...e, props });
  }).catch(($, e, next) =>
    lastKnownOn === false ? next(e) : placeholder($, e),
  );

  // The tool's output schema is kept: only string values change, so Bash's
  // `{ stdout, stderr, interrupted, ... }` stays that record.
  on("ui.render", { component: "ToolResult" }, async ($, e, next) =>
    (await readIsOn($))
      ? next({
          ...e,
          props: { ...e.props, output: maskValue(e.props.output, maskText) },
        })
      : next(e),
  ).catch(($, e, next) =>
    lastKnownOn === false ? next(e) : placeholder($, e),
  );

  // A folded group's count line can't be rewritten, so the group unfolds and
  // each call draws as a ToolUse row, which the hook above masks.
  on("ui.render", { component: "ToolGroup" }, async ($, e, next) =>
    (await readIsOn($))
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e),
  ).catch(($, e, next) =>
    lastKnownOn === false ? next(e) : placeholder($, e),
  );

  on("ui.render", { component: "CommandOutput" }, async ($, e, next) =>
    (await readIsOn($))
      ? next({ ...e, props: { ...e.props, text: maskText(e.props.text) } })
      : next(e),
  ).catch(($, e, next) =>
    lastKnownOn === false ? next(e) : placeholder($, e),
  );

  on("ui.render", { component: "InfoNotice" }, async ($, e, next) =>
    (await readIsOn($))
      ? next({ ...e, props: { ...e.props, text: maskText(e.props.text) } })
      : next(e),
  ).catch(($, e, next) =>
    lastKnownOn === false ? next(e) : placeholder($, e),
  );

  on("ui.render", { component: "AgentRow" }, async ($, e, next) => {
    if (!(await readIsOn($))) {
      return next(e);
    }

    const props = { ...e.props, label: maskText(e.props.label) };

    if (typeof e.props.body === "string") {
      props.body = maskText(e.props.body);
    }

    return next({ ...e, props });
  }).catch(($, e, next) =>
    lastKnownOn === false ? next(e) : placeholder($, e),
  );

  on("ui.render", { component: "Spinner" }, async ($, e, next) =>
    (await readIsOn($))
      ? next({
          ...e,
          props: {
            ...e.props,
            word: maskText(e.props.word),
            message:
              e.props.message === null ? null : maskText(e.props.message),
          },
        })
      : next(e),
  ).catch(($, e, next) =>
    lastKnownOn === false ? next(e) : placeholder($, e),
  );

  // The footer label, so the person sees masking is on before recording.
  // Not a masking hook: a failure here leaves the footer as the engine draws it.
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    if (!(await readIsOn($)) || e.props.modes.includes(MODE_LABEL)) {
      return next(e);
    }

    return next({
      ...e,
      props: { ...e.props, modes: [...e.props.modes, MODE_LABEL] },
    });
  }).catch(($, e, next) => next(e));
};
