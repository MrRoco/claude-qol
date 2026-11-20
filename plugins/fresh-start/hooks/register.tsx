import { atom, read, update } from "claude-code";
import type {
  EngineInterface,
  PluginOptions,
  Register,
  Timer,
  UiPressArgument,
} from "claude-code";

import type { Step } from "../types";

type Engine = EngineInterface;

const COMMAND = "fresh";
const COMMAND_DESCRIPTION =
  "Write a handoff of this chat and start fresh with it";

const DEFAULT_THRESHOLD = 250_000;
const MIN_THRESHOLD = 20_000;
const MAX_RUNS = 20;
const RUNS_KEY = "runs";
const TICK_MS = 1000;
const BAR_CELLS = 8;
const BAR_FILLED = 4;

// The fixed folder under the session root. Nothing from the chat or Claude's
// answer ever goes into a path.
const HANDOFF_DIR = ".claude/handoffs";

// Theme keys only, never fixed colours: `claude` is the theme's accent.
const ACCENT = "claude";
const SUCCESS = "success";
const DANGER = "error";

// The only text the mod sends the model.
const HANDOFF_PROMPT = `fresh-start: please write a handoff of this whole chat so the work can continue in a new chat
that has none of this context. Reply with only the handoff, in Markdown, with these sections:

# Handoff: <short title>
## Goal - what the person wants, in their own words where it matters
## Done so far - what is finished, with commits, files or results
## Current state - where things stand right now, including anything half done
## Decisions and rules - choices made, constraints and preferences to keep following
## Key files and commands - paths, commands and tools the next chat needs first
## Problems solved - errors met and how they were fixed, so they are not repeated
## Next steps - numbered, concrete, in order

Keep it complete but tight. Never include passwords, API keys, tokens or other secrets. Refer
to people outside the team by role, not by name, unless the work cannot continue without it.`;

const TEXT_STARTED = "Writing a handoff of this chat.";
const TEXT_BUSY = "A handoff is already in progress.";
const ERROR_SUBMIT = "Could not ask Claude for the handoff.";
const ERROR_UNFINISHED = "Claude did not finish the handoff.";
const ERROR_SAVE = "Could not save the handoff";
const ERROR_NO_ROOT = "no project folder";

const stepAtom = atom({ plugin: "fresh-start", key: "step" } as const, "idle");
const tokensAtom = atom({ plugin: "fresh-start", key: "tokens" } as const, null);
const dismissedAtom = atom(
  { plugin: "fresh-start", key: "dismissed" } as const,
  false,
);
const startedAtAtom = atom({ plugin: "fresh-start", key: "startedAt" } as const, null);
const fileAtom = atom({ plugin: "fresh-start", key: "file" } as const, null);
const errorAtom = atom({ plugin: "fresh-start", key: "error" } as const, null);

type Choice = "fresh" | "copy" | "cancel" | "failed";

/** One line of the run log: never the handoff text, never the chat's topic. */
type Run = {
  at: string;
  tokens: number | null;
  file: string | null;
  choice: Choice;
};

// Module variables: they survive `/clear` (which wipes `$.state`), not a reload.
// Counts runs, so the end of an older run never resets a newer one.
let runId = 0;
// The run waiting for its handoff turn, whether its submit has been sent, and
// the turn it got.
let pendingRun: number | null = null;
let isSubmitSeen = false;
// Slash or skill commands submitted while a run waits: each may start a main
// turn of its own (its rendered body as text), so that many unmatched main
// turns are skipped before ours.
let commandTurnsAhead = 0;
// Set around Start fresh's own `/clear`, which must keep the handoff text.
let isStartFreshClearing = false;
let pendingTurnId: string | null = null;
// The captured handoff, needed after `/clear` to fill the new chat's box.
let handoffText: string | null = null;
// Same-minute file names get -2, -3: tracked here, never by listing the folder.
let lastBaseName: string | null = null;
let sameMinuteCount = 0;
// Bumped by every dismiss, so a measure that read `dismissed` before it does
// not bring the offer back.
let dismissEpoch = 0;
// Set in the same synchronous step as the press that ends a run or dismisses
// the offer, before `dismissed` reaches the state; reset by `/clear`.
let isOfferDismissed = false;
// Texts of other-origin prompts whose turn has not started (see prompt.submit).
const otherPrompts: string[] = [];
const MAX_OTHER_PROMPTS = 10;
let ticker: Timer | undefined;

/** The threshold option, or the default when missing, not a number or too low. */
const readThreshold = (options: PluginOptions | undefined): number => {
  const value = options?.threshold;

  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_THRESHOLD
    ? value
    : DEFAULT_THRESHOLD;
};

const formatTokens = (tokens: number | null): string =>
  tokens === null ? "?" : `${Math.round(tokens / 1000)}k`;

const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const pad = (value: number): string => String(value).padStart(2, "0");

// From this band width task-bar's layout puts the row beside cache-timer, so
// the row keeps to its half: floor((columns - 1) / 2), the 1 is the gap.
const HALF_WIDTH_FROM = 100;
const OFFER_BUTTONS = ["Write handoff", "Not now"] as const;
const CHOOSE_BUTTONS = ["Start fresh chat", "Copy", "Cancel"] as const;

const rowColumns = (bodyColumns: number): number =>
  bodyColumns >= HALF_WIDTH_FROM
    ? Math.floor((bodyColumns - 1) / 2)
    : bodyColumns;

// What a button takes on the terminal: `[ label ]` plus its 1-column margin,
// and one cell of slack for glyphs a terminal may draw two cells wide.
const buttonColumns = (labels: readonly string[]): number =>
  labels.reduce((sum, label) => sum + label.length + 5, 0) + 1;

/** Cuts text to `room` columns, ending in `…` when cut. */
const clip = (text: string, room: number): string => {
  if (room <= 0) {
    return "";
  }

  return text.length <= room
    ? text
    : `${text.slice(0, Math.max(0, room - 1))}…`;
};

/** The file name alone, without its folder. */
const fileName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/** `yyyy-mm-dd-HHmm` in local time. */
const baseName = (ms: number): string => {
  const date = new Date(ms);

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
};

/** The next free file name for this minute, without reading the folder. */
const nextFileName = (ms: number): string => {
  const base = baseName(ms);

  if (base === lastBaseName) {
    sameMinuteCount += 1;
  } else {
    lastBaseName = base;
    sameMinuteCount = 1;
  }

  return sameMinuteCount === 1 ? `${base}.md` : `${base}-${sameMinuteCount}.md`;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : String(error);

/** Runs own work so that a failure never reaches the event or the turn. */
const safely = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch {
    // Observe only: the event goes on untouched. Nothing is logged, as a
    // handoff may hold client details.
  }
};

const isRun = (value: unknown): value is Run =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Run).at === "string" &&
  typeof (value as Run).choice === "string";

/** Appends one run to the log in `$.store`, keeping the last 20. */
const logRun = async ($: Engine, choice: Choice): Promise<void> => {
  await safely(async () => {
    const stored = await $.store.get(RUNS_KEY);
    const runs = Array.isArray(stored) ? stored.filter(isRun) : [];
    const run: Run = {
      at: new Date(await $.clock.now()).toISOString(),
      tokens: await read($, tokensAtom),
      file: await read($, fileAtom),
      choice,
    };
    await $.store.set(RUNS_KEY, [...runs, run].slice(-MAX_RUNS));
  });
};

const stopTicker = (): void => {
  ticker?.cancel();
  ticker = undefined;
};

/** Redraws the row once a second while Claude writes, for the bar and the time. */
const startTicker = ($: Engine): void => {
  if (ticker === undefined) {
    ticker = $.clock.every(TICK_MS, () => $.ui.invalidate("ui.render"));
  }
};

/** Removes one waiting other-origin prompt by text; whether there was one. */
const forgetOtherPrompt = (text: string): boolean => {
  const index = otherPrompts.indexOf(text);

  if (index === -1) {
    return false;
  }

  otherPrompts.splice(index, 1);

  return true;
};

const dropPendingTurn = (): void => {
  pendingRun = null;
  isSubmitSeen = false;
  commandTurnsAhead = 0;
  pendingTurnId = null;
};

/**
 * Shows the failed row for `run`, only while that run is still current and,
 * when `from` is given, still at that step (a Cancel may have ended it).
 */
const fail = async (
  $: Engine,
  error: string,
  run: number,
  from?: Step,
): Promise<void> => {
  let isFailed = false;
  await update($, stepAtom, (step) => {
    if (run !== runId || (from !== undefined && step !== from)) {
      return step;
    }

    isFailed = true;

    return "failed";
  });

  if (isFailed) {
    stopTicker();
    await update($, errorAtom, () => error);
  }
};

/**
 * Asks Claude for the handoff in this chat, when no run is under way. Returns
 * whether it started. The step is taken in one synchronous update, so two
 * presses or a press and `/fresh` cannot both start.
 */
const startWriting = async (
  $: Engine,
  from: readonly Step[],
  isFromCommand = false,
): Promise<boolean> => {
  let isStarted = false;
  await update($, stepAtom, (step) => {
    if (!from.includes(step)) {
      return step;
    }

    isStarted = true;

    return "writing";
  });

  if (!isStarted) {
    return false;
  }

  runId += 1;
  const run = runId;
  handoffText = null;
  pendingRun = run;
  isSubmitSeen = false;
  commandTurnsAhead = 0;
  pendingTurnId = null;
  await update($, fileAtom, () => null);
  await update($, errorAtom, () => null);
  await update($, startedAtAtom, () => null);
  await safely(async () => {
    const now = await $.clock.now();
    await update($, startedAtAtom, () => now);
  });
  startTicker($);

  const submit = (): void => {
    if (pendingRun !== run) {
      return;
    }

    // From here the next main-loop turn that is not another prompt's is ours.
    isSubmitSeen = true;
    void $.prompt
      .submit({ text: HANDOFF_PROMPT })
      .then((result) => {
        if (result.drop !== undefined) {
          throw new Error(result.drop);
        }
      })
      .catch(async () => {
        // Only while this run still waits: a cancelled or newer one stays.
        if (pendingRun !== run) {
          return;
        }

        dropPendingTurn();
        await safely(() => fail($, ERROR_SUBMIT, run, "writing"));
      });
  };

  // Not awaited: the submit resolves only once the turn starts. The host
  // refuses a submit from inside a command.run hook (it would wait on the
  // turn that hook holds), so `/fresh` hands it to the clock to run after.
  if (isFromCommand) {
    $.clock.after(0, submit);
  } else {
    submit();
  }

  return true;
};

/**
 * Saves the handoff under `<root>/.claude/handoffs/`: the folder's own
 * `.gitignore` first, so the file is never visible to git, then the file.
 * The path is built from the root and fixed parts only.
 */
const saveHandoff = async (
  $: Engine,
  text: string,
  run: number,
): Promise<void> => {
  try {
    const root = (await $.session.root()).replace(/[\\/]+$/, "");

    if (root === "") {
      throw new Error(ERROR_NO_ROOT);
    }

    const now = await $.clock.now();
    const tokens = await read($, tokensAtom);
    const name = nextFileName(now);
    const file = `${HANDOFF_DIR}/${name}`;
    const header = `<!-- fresh-start ${new Date(now).toISOString()}, context ${tokens === null ? "unknown" : String(tokens)} tokens -->`;

    await $.fs.write(`${root}/${HANDOFF_DIR}/.gitignore`, "*\n");
    await $.fs.write(`${root}/${file}`, `${header}\n${text}\n`);
    // The file is written either way; the row moves on only while the run
    // was not cancelled meanwhile.
    if (run === runId && (await read($, stepAtom)) === "saving") {
      await update($, fileAtom, () => file);
      await update($, stepAtom, (step) =>
        step === "saving" && run === runId ? "choose" : step,
      );
    }
  } catch (error) {
    // `handoffText` stays, so the failed row still offers Copy.
    await safely(() =>
      fail($, `${ERROR_SAVE}: ${errorMessage(error)}`, run, "saving"),
    );
  }
};

/**
 * Ends a run: no offer again in this conversation, and, unless a newer run
 * started meanwhile (a `/fresh` during the copy), no row and no text kept.
 */
const finish = async ($: Engine, run: number): Promise<void> => {
  dismissEpoch += 1;
  isOfferDismissed = true;
  await update($, dismissedAtom, () => true);

  if (run !== runId) {
    return;
  }

  handoffText = null;
  stopTicker();
  await update($, stepAtom, (step) => (run === runId ? "idle" : step));
};

const resetState = async ($: Engine): Promise<void> => {
  isOfferDismissed = false;
  await update($, stepAtom, () => "idle");
  await update($, tokensAtom, () => null);
  await update($, dismissedAtom, () => false);
  await update($, startedAtAtom, () => null);
  await update($, fileAtom, () => null);
  await update($, errorAtom, () => null);
};

/**
 * Takes the row for one press: moves `step` to `idle` in one synchronous
 * update when `canPress` allows it, so a second press finds nothing to do.
 * Returns the step it was taken from, or undefined when it was not taken.
 */
const claim = async (
  $: Engine,
  canPress: (step: Step) => boolean,
): Promise<{ step: Step; run: number } | undefined> => {
  let taken: { step: Step; run: number } | undefined;
  await update($, stepAtom, (step) => {
    if (!canPress(step)) {
      return step;
    }

    taken = { step, run: runId };
    // The run ends here: a measure landing during the press's awaits must
    // not bring the offer back.
    dismissEpoch += 1;
    isOfferDismissed = true;

    return "idle";
  });

  return taken;
};

const pressStartFresh = async (
  $: Engine,
  surface: UiPressArgument["surface"],
): Promise<void> => {
  const file = (await read($, fileAtom)) ?? HANDOFF_DIR;

  const taken = await claim($, (step) => step === "choose");

  if (taken === undefined) {
    return;
  }

  const text = handoffText;
  const fallback = `Handoff saved in ${file}. Paste it from there.`;
  await logRun($, "fresh");
  stopTicker();

  try {
    // Only ever `clear`, and only on the person's press.
    isStartFreshClearing = true;
    await $.command.run({ command: "clear" });
  } catch {
    // No fresh chat: the handoff still goes to the clipboard below.
    await safely(() => finish($, taken.run));
    await copyFallback($, text, fallback, surface);

    return;
  } finally {
    isStartFreshClearing = false;
  }

  // `/clear` wiped `$.state`; this writes the same blank state in case the
  // host had not, so the old row does not stay in the new chat.
  if (taken.run === runId) {
    handoffText = null;
    await safely(() => resetState($));
  }

  if (text === null) {
    $.ui.toast(fallback);

    return;
  }

  let isFilled = false;

  try {
    isFilled = (await $.prompt.fill({ text })).isFilled;
  } catch {
    isFilled = false;
  }

  if (!isFilled) {
    await copyFallback($, text, fallback, surface);
  }
};

const copyFallback = async (
  $: Engine,
  text: string | null,
  toast: string,
  surface: UiPressArgument["surface"],
): Promise<void> => {
  if (text !== null) {
    await safely(async () => {
      await $.ui.copy({ text, surface });
    });
  }

  $.ui.toast(toast);
};

const pressCopy = async (
  $: Engine,
  surface: UiPressArgument["surface"],
): Promise<void> => {
  const text = handoffText;
  const taken = await claim(
    $,
    (step) => step === "choose" || (step === "failed" && text !== null),
  );

  if (taken === undefined) {
    return;
  }

  // After a failed save there is no file to point to.
  const file = taken.step === "choose" ? await read($, fileAtom) : null;
  let isCopied = false;

  if (text !== null) {
    try {
      isCopied = (await $.ui.copy({ text, surface })).isCopied;
    } catch {
      isCopied = false;
    }
  }

  $.ui.toast(
    file === null
      ? isCopied
        ? "Handoff copied."
        : "Could not copy the handoff."
      : isCopied
        ? `Handoff copied. Saved in ${file}.`
        : `Could not copy. The handoff is in ${file}.`,
  );
  await logRun($, "copy");
  await finish($, taken.run);
};

const pressCancel = async ($: Engine): Promise<void> => {
  const taken = await claim(
    $,
    (step) =>
      step === "choose" ||
      step === "failed" ||
      step === "writing" ||
      step === "saving",
  );

  if (taken === undefined) {
    return;
  }

  if (taken.step === "writing") {
    // The handoff turn may still run in the chat; its end is no longer ours.
    dropPendingTurn();
  }

  await logRun($, taken.step === "failed" ? "failed" : "cancel");
  await finish($, taken.run);
};

const pressDismiss = async ($: Engine): Promise<void> => {
  let isDismissed = false;
  await update($, stepAtom, (step) => {
    if (step !== "offer") {
      return step;
    }

    isDismissed = true;
    dismissEpoch += 1;
    isOfferDismissed = true;

    return "idle";
  });

  if (isDismissed) {
    await update($, dismissedAtom, () => true);
  }
};

export const register: Register = (on, options) => {
  const threshold = readThreshold(options);
  stopTicker();

  // Fires at the session's start and at every reload: it registers, never
  // resets, so a reload keeps the run's state.
  on("session.start", async ($, e, next) => {
    await safely(async () => {
      await $.command.register({
        name: COMMAND,
        description: COMMAND_DESCRIPTION,
      });
    });

    return next(e);
  });

  // A `/clear` mid-run drops the turn being waited for; `handoffText` stays,
  // as the Start fresh press needs it after its own `/clear`.
  on("session.end", ($, e, next) => {
    if (e.reason === "clear") {
      dropPendingTurn();
      otherPrompts.length = 0;
      // The person's own /clear: no reason left to hold the text in memory.
      if (!isStartFreshClearing) {
        handoffText = null;
      }
      stopTicker();
      // A new conversation may be offered a handoff again.
      isOfferDismissed = false;
    }

    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    const tokens = e.context.tokens;

    if (typeof tokens === "number") {
      const epoch = dismissEpoch;
      await safely(async () => {
        await update($, tokensAtom, () => tokens);

        if (tokens < threshold || (await read($, dismissedAtom))) {
          return;
        }

        // Decided in one synchronous step: a dismiss that landed meanwhile wins.
        await update($, stepAtom, (step) =>
          step === "idle" && epoch === dismissEpoch && !isOfferDismissed
            ? "offer"
            : step,
        );
      });
    }

    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    let isStarted = false;

    try {
      isStarted = await startWriting($, ["idle", "offer", "failed"], true);
    } catch {
      isStarted = false;
    }

    // For the person alone: the handoff prompt is the only text the model gets.
    return {
      text: isStarted ? TEXT_STARTED : TEXT_BUSY,
      isTextDisplayOnly: true,
    };
  }).catch(() => ({ text: ERROR_SUBMIT, isTextDisplayOnly: true as const }));

  // Prompts of any other origin (the person's, a task notification, another
  // mod's) whose turn has not started yet, by text: such a turn is never the
  // handoff turn. The engine does not raise our own submit to our own hooks,
  // and `turn.start` names no origin, so this is how they are told apart.
  // Memory only, at most a few entries, never written or logged.
  on("prompt.submit", async ($, e, next) => {
    const isOwn = e.origin.kind === "plugin" && e.origin.name === "fresh-start";

    if (!isOwn && e.command === undefined) {
      otherPrompts.push(e.text);
      otherPrompts.splice(0, Math.max(0, otherPrompts.length - MAX_OTHER_PROMPTS));
    }

    // Our own /fresh starts no turn; a local command such as /help does not
    // either, but nothing here tells it from a skill (a README limit).
    const isCommandWhileWaiting =
      !isOwn &&
      e.command !== undefined &&
      e.command.name !== COMMAND &&
      pendingRun !== null;
    const result = await next(e);

    // A prompt that did not enter starts no turn.
    if (!isOwn && result.drop !== undefined) {
      forgetOtherPrompt(e.text);
    } else if (isCommandWhileWaiting && pendingRun !== null) {
      commandTurnsAhead += 1;
    }

    return result;
  }).catch(($, e, next) => next(e));

  // The handoff turn is the first main-loop turn that starts after our submit
  // and is not the turn of another prompt seen above.
  // A continuation (empty text) is never ours either.
  on("turn.start", ($, e, next) => {
    if (e.agentId === undefined && e.text !== "") {
      const isOther = forgetOtherPrompt(e.text);

      if (!isOther && pendingRun !== null && pendingTurnId === null) {
        if (commandTurnsAhead > 0) {
          commandTurnsAhead -= 1;
        } else if (isSubmitSeen) {
          pendingTurnId = e.turnId;
        }
      }
    }

    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (
      e.agentId !== undefined ||
      pendingTurnId === null ||
      e.turnId !== pendingTurnId
    ) {
      return next(e);
    }

    // Taken synchronously, so the turn is captured once.
    dropPendingTurn();
    const run = runId;
    const answer = e.reason === "answer" ? e.answer.trim() : "";
    stopTicker();

    await safely(async () => {
      if (answer === "") {
        await fail($, ERROR_UNFINISHED, run, "writing");

        return;
      }

      let isSaving = false;
      await update($, stepAtom, (step) => {
        if (step !== "writing" || run !== runId) {
          return step;
        }

        isSaving = true;

        return "saving";
      });

      if (isSaving) {
        handoffText = answer;
        await saveHandoff($, answer, run);
      }
    });

    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const step = await read($, stepAtom);

    if (step !== "writing") {
      stopTicker();
    }

    if (step === "idle" || e.props.hasSurvey) {
      return next(e);
    }

    const { Box, Button, Text } = $.ui.resolve(e);
    const isHalf = e.props.bodyColumns >= HALF_WIDTH_FROM;
    const columns = rowColumns(e.props.bodyColumns);
    // At half width the lead is cut to what its buttons leave, so the buttons
    // never are; at full width the Text's own truncation does it, as before.
    const fit = (text: string, labels: readonly string[]): string =>
      isHalf ? clip(text, columns - buttonColumns(labels)) : text;

    // Each lead text takes what the buttons leave and is cut at its end.
    const lead = (text: string, color: string) => (
      <Box flexShrink={1}>
        <Text color={color} wrap="truncate-end">
          {text}
        </Text>
      </Box>
    );
    const later = (text: string) => (
      <Box flexShrink={0}>
        <Text dimColor>{text}</Text>
      </Box>
    );
    const button = (
      key: string,
      label: string,
      onPress: (press: UiPressArgument) => void,
      isPrimary = false,
    ) => (
      <Box flexShrink={0} marginLeft={1}>
        <Button
          key={key}
          label={label}
          {...(isPrimary ? { variant: "primary" as const } : {})}
          onPress={onPress}
        />
      </Box>
    );

    if (step === "offer") {
      const tokens = await read($, tokensAtom);

      return (
        <Box flexDirection="row" width={columns}>
          {lead(
            isHalf
              ? fit(`◆ Chat at ${formatTokens(tokens)} tokens.`, OFFER_BUTTONS)
              : `◆ This chat is at ${formatTokens(tokens)} tokens.`,
            ACCENT,
          )}
          {button(
            "write",
            "Write handoff",
            () => void startWriting($, ["offer"]),
            true,
          )}
          {button("not-now", "Not now", () => void pressDismiss($))}
        </Box>
      );
    }

    if (step === "writing") {
      // After a reload the ticker is gone: drawing starts it again.
      try {
        startTicker($);
      } catch {
        // The next state change redraws instead.
      }

      const now = await $.clock.now();
      const startedAt = (await read($, startedAtAtom)) ?? now;
      const elapsed = now - startedAt;
      // Indeterminate: a block of cells that moves one cell per second.
      const offset = Math.floor(Math.max(0, elapsed) / TICK_MS) % BAR_CELLS;
      const cells = Array.from(
        { length: BAR_CELLS },
        (_, index) => (index - offset + BAR_CELLS) % BAR_CELLS < BAR_FILLED,
      );
      // Runs of filled and empty cells, each one Text.
      const runs: { isFilled: boolean; length: number }[] = [];

      for (const isFilled of cells) {
        const last = runs[runs.length - 1];

        if (last !== undefined && last.isFilled === isFilled) {
          last.length += 1;
        } else {
          runs.push({ isFilled, length: 1 });
        }
      }

      const head = "① Writing ▕";
      const clock = `▏ ${formatElapsed(elapsed)}`;
      const rest = "  ② Saving  ③ Choose";
      // Half width keeps bar and elapsed time; the step labels give way first.
      const isShort =
        isHalf &&
        head.length + BAR_CELLS + clock.length + rest.length +
          buttonColumns(["Cancel"]) >
          columns;

      return (
        <Box flexDirection="row" width={columns}>
          <Box flexShrink={0}>
            <Text color={ACCENT}>{isShort ? "① ▕" : head}</Text>
          </Box>
          {runs.map((run, index) => (
            <Box flexShrink={0} key={`bar-${index}`}>
              {run.isFilled ? (
                <Text color={ACCENT}>{"█".repeat(run.length)}</Text>
              ) : (
                <Text dimColor>{"░".repeat(run.length)}</Text>
              )}
            </Box>
          ))}
          <Box flexShrink={0}>
            <Text color={ACCENT}>{clock}</Text>
          </Box>
          {later(isShort ? "  ② ③" : rest)}
          {/* Always a way out, also after a reload lost the run's turn. */}
          {button("cancel", "Cancel", () => void pressCancel($))}
        </Box>
      );
    }

    if (step === "saving") {
      return (
        <Box flexDirection="row" width={columns}>
          <Box flexShrink={0}>
            <Text color={SUCCESS}>✓ Writing</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={ACCENT}>{"  ② Saving"}</Text>
          </Box>
          {later("  ③ Choose")}
          {button("cancel", "Cancel", () => void pressCancel($))}
        </Box>
      );
    }

    if (step === "choose") {
      const file = await read($, fileAtom);
      const saved = isHalf
        ? fit(`✓ ${file === null ? HANDOFF_DIR : fileName(file)}`, CHOOSE_BUTTONS)
        : `✓ Saved ${file ?? HANDOFF_DIR}`;

      return (
        <Box flexDirection="row" width={columns}>
          {lead(saved, SUCCESS)}
          {button(
            "fresh",
            "Start fresh chat",
            (press) => void pressStartFresh($, press.surface),
            true,
          )}
          {button("copy", "Copy", (press) => void pressCopy($, press.surface))}
          {button("cancel", "Cancel", () => void pressCancel($))}
        </Box>
      );
    }

    // failed
    const error = (await read($, errorAtom)) ?? ERROR_UNFINISHED;

    return (
      <Box flexDirection="row" width={columns}>
        {lead(
          fit(`✗ ${error}`, handoffText !== null ? ["Copy", "Close"] : ["Close"]),
          DANGER,
        )}
        {handoffText !== null &&
          button("copy", "Copy", (press) => void pressCopy($, press.surface))}
        {button("close", "Close", () => void pressCancel($))}
      </Box>
    );
  });
};
