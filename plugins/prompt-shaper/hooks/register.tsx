import { atom, read, update } from "claude-code";
import type { EngineInterface, PluginOptions, Register } from "claude-code";

import type { Step } from "../types";

type Engine = EngineInterface;

const COMMAND = "shape";
const COMMAND_DESCRIPTION =
  "Turn a prompt into a clear brief in the prompt box";
const COMMAND_HINT = "<your prompt>";

const DEFAULT_MIN_LENGTH = 400;
const LOWEST_MIN_LENGTH = 100;
const MODELS = ["haiku", "sonnet"] as const;
const DEFAULT_MODEL = "haiku";
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 30_000;
const MAX_QUESTIONS = 3;
// Keeps one odd question from filling the row; a real question is far shorter.
const MAX_QUESTION_LENGTH = 300;
const SEND_AS_IS = ">>";
// The box keeps a dropped prompt; it is emptied once it shows up there.
const CLEAR_TRIES = 20;
const CLEAR_STEP_MS = 50;

// Theme keys only, never fixed colours: `claude` is the theme's accent.
const ACCENT = "claude";
const DANGER = "error";

const QUESTIONS_SYSTEM = `You review a prompt someone wants to send to a coding assistant. Find at most three things
that are missing, unclear or contradict each other and that would change the result. Ask
each as one short question in the language of the prompt. If nothing important is missing,
ask nothing. Reply with JSON only: {"questions": ["..."]}`;

const BRIEF_SYSTEM = `Rewrite the prompt into a brief for a coding assistant, in the language of the prompt.
Keep every fact, name, path and requirement; add nothing that was not said or answered. Use
exactly these Markdown sections: ## Task, ## Context, ## Constraints, ## Done when. Leave a
section out only if there is nothing for it. Reply with the brief only.`;

const TEXT_DROP = "prompt-shaper is reading your prompt.";
const TEXT_USAGE = "Usage: /shape <your prompt>";
const TEXT_BUSY = "prompt-shaper is already busy with a prompt.";
const TEXT_STARTED = "Shaping your prompt.";
const TEXT_NOT_STARTED = "prompt-shaper could not start.";
const TEXT_READY = "Brief ready in the prompt box. Edit and send it.";
const TEXT_FAILED = "Could not shape the prompt; your text is back in the box.";
const TEXT_READING = "◇ prompt-shaper · reading your prompt…";
const TEXT_WRITING = "◇ prompt-shaper · writing the brief…";
const TEXT_ANSWER_HINT =
  "Answer in the prompt box and press Enter. Start with >> to send Claude a message instead.";
const answerNoted = (number: number, total: number): string =>
  `prompt-shaper noted answer ${number} of ${total}.`;
const TEXT_HELD =
  "◇ prompt-shaper · the prompt box did not take this text; copy it from here:";
const TEXT_LOST = "◇ prompt-shaper · this run was lost in a reload.";

const stepAtom = atom(
  { plugin: "prompt-shaper", key: "step" } as const,
  "idle",
);
const questionsAtom = atom(
  { plugin: "prompt-shaper", key: "questions" } as const,
  [],
);
const indexAtom = atom({ plugin: "prompt-shaper", key: "index" } as const, 0);
const answersAtom = atom(
  { plugin: "prompt-shaper", key: "answers" } as const,
  [],
);

// Module variables, never in `$.state`, never written or logged.
// Counts runs; `activeRun` is the one under way, null when none is. A request
// or press of an older run finds it changed and does nothing.
let runId = 0;
let activeRun: number | null = null;
// The caught prompt of the active run.
let original: string | null = null;
// The text the held row shows when the prompt box refused it.
let heldText: string | null = null;

type Settings = { minLength: number; model: string };

/** The options, each falling back to its default when missing or out of range. */
const readSettings = (options: PluginOptions | undefined): Settings => {
  const minLength = options?.minLength;
  const model = options?.model;

  return {
    minLength:
      typeof minLength === "number" &&
      Number.isFinite(minLength) &&
      minLength >= LOWEST_MIN_LENGTH
        ? minLength
        : DEFAULT_MIN_LENGTH,
    model:
      typeof model === "string" && (MODELS as readonly string[]).includes(model)
        ? model
        : DEFAULT_MODEL,
  };
};

/** Runs own work so that a failure never reaches the event or the person. */
const safely = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch {
    // Nothing is logged: the prompt may hold client details.
  }
};

/** The last part of a path, for the one line of context the model gets. */
const folderName = (root: string): string => {
  const parts = root.split(/[\\/]+/).filter((part) => part !== "");

  return parts[parts.length - 1] ?? "";
};

const asQuestions = (values: unknown[]): string[] =>
  values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .slice(0, MAX_QUESTIONS)
    .map((value) =>
      value.length > MAX_QUESTION_LENGTH
        ? `${value.slice(0, MAX_QUESTION_LENGTH - 1)}…`
        : value,
    );

/**
 * The questions in the model's reply: the `questions` list of its JSON, else
 * the first strings found in it (bar the key itself), else none.
 */
const parseQuestions = (reply: string): string[] => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");

  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(reply.slice(start, end + 1));

      if (typeof parsed === "object" && parsed !== null) {
        const list = (parsed as { questions?: unknown }).questions;

        return Array.isArray(list) ? asQuestions(list) : [];
      }
    } catch {
      // Not JSON as a whole: fall back to the strings in it below.
    }
  }

  const strings: unknown[] = [];

  for (const match of reply.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    try {
      const value: unknown = JSON.parse(`"${match[1] ?? ""}"`);

      if (value !== "questions") {
        strings.push(value);
      }
    } catch {
      // A broken escape: skip that string.
    }
  }

  return asQuestions(strings);
};

/** The brief request's prompt: the original, then each answered question. */
const briefPrompt = (
  text: string,
  questions: readonly string[],
  answers: readonly (string | null)[],
): string => {
  const pairs = questions.flatMap((question, index) => {
    const answer = answers[index];

    return typeof answer === "string" ? [`Q: ${question} A: ${answer}`] : [];
  });

  return pairs.length === 0 ? text : `${text}\n\nAnswers:\n${pairs.join("\n")}`;
};

/** One side request; the reply's text, or null when it was not answered. */
const ask = async (
  $: Engine,
  settings: Settings,
  system: string,
  prompt: string,
): Promise<string | null> => {
  try {
    const result = await $.model.complete({
      model: settings.model,
      system,
      prompt,
      maxTokens: MAX_TOKENS,
      timeoutMs: TIMEOUT_MS,
    });

    return result.isAnswered ? result.text : null;
  } catch {
    // Only a request the engine refuses to send rejects (a blocked model).
    return null;
  }
};

/** Back to no run in `$.state`; the row then draws nothing. */
const resetState = async ($: Engine): Promise<void> => {
  await update($, stepAtom, () => "idle");
  await update($, questionsAtom, () => []);
  await update($, indexAtom, () => 0);
  await update($, answersAtom, () => []);
};

/** `text` with the `>>` marker in front, unless it already starts with one. */
const withMarker = (text: string): string =>
  text.startsWith(SEND_AS_IS) ? text : `${SEND_AS_IS} ${text}`;

/**
 * Puts text in the prompt box: over an empty box, or after what was typed
 * meanwhile with a blank line between, so nothing typed is lost. Whether the
 * box took it.
 *
 * `isMarked` starts the box with the `>>` marker, so sending a brief does not
 * get it caught and shaped again. The guard only honours the marker at the
 * very start, so with text typed meanwhile the box is rewritten as marker,
 * that text, then the brief.
 */
const fillBox = async (
  $: Engine,
  text: string,
  isMarked = false,
): Promise<boolean> => {
  let draft: string | null = null;

  try {
    draft = (await $.prompt.read()).text;
  } catch {
    // Unknown box: append without a separator, which never overwrites.
    draft = null;
  }

  const marked = (body: string): string => (isMarked ? withMarker(body) : body);

  try {
    let result;

    if (draft !== null && draft.trim() === "") {
      result = await $.prompt.fill({ text: marked(text), mode: "replace" });
    } else if (draft !== null && isMarked) {
      // No fill mode inserts at the start, so the box is rewritten from the
      // draft just read; a key pressed between that read and this fill is lost.
      result = await $.prompt.fill({
        text: marked(`${draft}\n\n${text}`),
        mode: "replace",
      });
    } else {
      result = await $.prompt.fill({
        text: draft === null ? text : `\n\n${text}`,
        mode: "append",
      });
    }

    return result.isFilled;
  } catch {
    return false;
  }
};

/**
 * Empties the prompt box of a prompt the guard just dropped, so the person
 * can type an answer at once. The engine puts the text back after the hook
 * answered, so this waits for it to show up. Leaves the box alone as soon as
 * it holds anything else: that is the person's own typing.
 */
const clearDropped = async ($: Engine, dropped: string): Promise<void> => {
  const target = dropped.trim();

  for (let i = 0; i < CLEAR_TRIES; i += 1) {
    await $.clock.sleep(CLEAR_STEP_MS);
    const draft = (await $.prompt.read()).text.trim();

    if (draft === target) {
      await $.prompt.fill({ text: "", mode: "replace" });

      return;
    }

    if (draft !== "") {
      return;
    }
  }
};

// An `@path` mention: the engine expands it only for a prompt sent from the
// box, never for one a plugin sends.
const MENTION = /(^|\s)@\S/;

/**
 * Sends the original exactly as it was entered, as the person's own prompt.
 * A plugin origin passes the guard, so it is not caught again. Whether it was
 * sent.
 */
const sendOriginal = async ($: Engine, text: string): Promise<boolean> => {
  // Sent by the mod, its file mentions would reach the model as plain text:
  // it goes back to the box instead (marked), where Enter expands them.
  if (MENTION.test(text)) {
    return false;
  }

  try {
    const result = await $.prompt.submit({ text, asUser: true });

    return result.drop === undefined;
  } catch {
    return false;
  }
};

/**
 * Ends `run` when it is still the active one. The brief goes to the prompt
 * box; on Cancel the original is sent as entered; on failure and `/clear`
 * (`restore`) the original goes back to the box. Taken synchronously, so a
 * late reply or a second press finds the run gone.
 */
const endRun = async (
  $: Engine,
  run: number,
  outcome: "brief" | "cancel" | "restore" | "failed",
  brief = "",
): Promise<void> => {
  if (run !== activeRun) {
    return;
  }

  activeRun = null;
  const text = outcome === "brief" ? brief : (original ?? "");
  original = null;

  await safely(() => resetState($));

  if (text === "") {
    return;
  }

  if (outcome === "cancel" && (await sendOriginal($, text))) {
    return;
  }

  // A brief, or an original whose send was refused, carries the marker:
  // pressing Enter then sends it unchanged instead of shaping it again.
  const isMarked = outcome === "brief" || outcome === "cancel";

  if (await fillBox($, text, isMarked)) {
    if (outcome === "brief") {
      $.ui.toast(TEXT_READY);
    } else if (outcome === "failed") {
      $.ui.toast(TEXT_FAILED);
    }

    return;
  }

  // The box refused it: the row shows the text instead, so it is not lost.
  // Only while no new run started during the fill.
  if (activeRun === null) {
    // A brief keeps its marker here too, so copying and sending it passes.
    heldText = isMarked ? withMarker(text) : text;
    await safely(async () => {
      await update($, stepAtom, (step) => (step === "idle" ? "held" : step));
    });
  }
};

/** Asks for the brief once the questions are done. */
const writeBrief = async (
  $: Engine,
  settings: Settings,
  run: number,
): Promise<void> => {
  const text = original;

  if (run !== activeRun || text === null) {
    return;
  }

  const questions = await read($, questionsAtom);
  const answers = await read($, answersAtom);
  const reply = await ask(
    $,
    settings,
    BRIEF_SYSTEM,
    briefPrompt(text, questions, answers),
  );
  const brief = reply?.trim() ?? "";

  await endRun($, run, brief === "" ? "failed" : "brief", brief);
};

/** Moves `run` on to writing, when it is still active, and asks for the brief. */
const toWriting = async (
  $: Engine,
  settings: Settings,
  run: number,
): Promise<void> => {
  let isWriting = false;
  await update($, stepAtom, (step) => {
    isWriting = run === activeRun && (step === "reading" || step === "asking");

    return isWriting ? "writing" : step;
  });

  if (isWriting) {
    await writeBrief($, settings, run);
  }
};

/** The question request; then the questions, or straight to writing. */
const readPrompt = async (
  $: Engine,
  settings: Settings,
  run: number,
): Promise<void> => {
  const text = original;

  if (run !== activeRun || text === null) {
    return;
  }

  let folder = "";

  try {
    folder = folderName(await $.session.root());
  } catch {
    folder = "";
  }

  const reply = await ask(
    $,
    settings,
    QUESTIONS_SYSTEM,
    `Project folder: ${folder === "" ? "unknown" : folder}\n\nPrompt:\n${text}`,
  );

  if (run !== activeRun) {
    return;
  }

  if (reply === null) {
    await endRun($, run, "failed");

    return;
  }

  const questions = parseQuestions(reply);

  if (questions.length === 0) {
    await toWriting($, settings, run);

    return;
  }

  // Each write checks the run again: a Cancel between them leaves no
  // questions of an ended run behind.
  await update($, questionsAtom, (current) =>
    run === activeRun ? questions : current,
  );
  await update($, indexAtom, (current) => (run === activeRun ? 0 : current));
  await update($, answersAtom, (current) => (run === activeRun ? [] : current));
  await update($, stepAtom, (step) =>
    run === activeRun && step === "reading" ? "asking" : step,
  );
};

/**
 * Starts a run on `text` when none is under way; whether it started. The
 * step is taken in one synchronous update, so two starts cannot both win.
 * The run's requests go on unawaited.
 */
const startRun = async (
  $: Engine,
  settings: Settings,
  text: string,
): Promise<boolean> => {
  // The run is taken inside the updater, so no drawing in between finds the
  // step moved but no run behind it.
  let claimed: number | null = null;

  try {
    await update($, stepAtom, (step) => {
      if (claimed !== null && claimed === activeRun) {
        // A retry of this same update: the run is already ours.
        return "reading";
      }

      if (step !== "idle" || activeRun !== null) {
        return step;
      }

      runId += 1;
      claimed = runId;
      activeRun = claimed;
      original = text;
      heldText = null;

      return "reading";
    });
  } catch (error) {
    // The step was not written: the run never started.
    abandonRun(claimed);
    throw error;
  }

  if (claimed === null) {
    return false;
  }

  const run: number = claimed;

  void (async () => {
    try {
      await update($, questionsAtom, (current) =>
        run === activeRun ? [] : current,
      );
      await update($, indexAtom, (current) =>
        run === activeRun ? 0 : current,
      );
      await update($, answersAtom, (current) =>
        run === activeRun ? [] : current,
      );
      await readPrompt($, settings, run);
    } catch {
      await safely(() => endRun($, run, "failed"));
    }
  })();

  return true;
};

/**
 * Drops `run` without putting anything in the box: for a run whose prompt
 * is being sent after all. Its late replies find it gone.
 */
const abandonRun = (run: number | null): void => {
  if (run !== null && run === activeRun) {
    activeRun = null;
    original = null;
  }
};

/**
 * Runs a step of `run`; should it fail, the run ends as failed and the
 * original goes back to the box.
 */
const orFail = async (
  $: Engine,
  run: number,
  work: () => Promise<void>,
): Promise<void> => {
  try {
    await work();
  } catch {
    await safely(() => endRun($, run, "failed"));
  }
};

type Recorded = { number: number; total: number; isLast: boolean };

/**
 * Records the answer (null when skipped) to the open question of `run`, once:
 * the index moves on in one synchronous update. `drawn` is the question a
 * button was drawn for; null takes whichever is open (an answer typed in the
 * prompt box). `isSkipAll` skips that question and every one after it.
 * Which question was answered, or null when none of `run` was open.
 */
const recordAnswer = async (
  $: Engine,
  run: number,
  drawn: number | null,
  answer: string | null,
  isSkipAll = false,
): Promise<Recorded | null> => {
  const questions = await read($, questionsAtom);
  // -1 while no question was taken; set inside the updater, which may rerun.
  let taken = -1;
  await update($, indexAtom, (index) => {
    const isOpen =
      run === activeRun &&
      index < questions.length &&
      (drawn === null || index === drawn);
    taken = isOpen ? index : -1;

    if (!isOpen) {
      return index;
    }

    return isSkipAll ? questions.length : index + 1;
  });

  if (taken === -1) {
    return null;
  }

  const at = taken;
  await update($, answersAtom, (answers) => {
    const next = [...answers];
    next[at] = answer;

    for (let i = at + 1; isSkipAll && i < questions.length; i += 1) {
      next[i] = null;
    }

    return next;
  });

  return {
    number: at + 1,
    total: questions.length,
    isLast: isSkipAll || at + 1 >= questions.length,
  };
};

/** A button's answer: records it, then writes once the last one is in. */
const answerQuestion = async (
  $: Engine,
  settings: Settings,
  run: number,
  drawn: number,
  answer: string | null,
  isSkipAll = false,
): Promise<void> => {
  const recorded = await recordAnswer($, run, drawn, answer, isSkipAll);

  if (recorded?.isLast === true) {
    await toWriting($, settings, run);
  }
};

/** Cancel at any step: the original is sent exactly as it was entered. */
const cancel = async ($: Engine, run: number | null): Promise<void> => {
  if (run !== null && run === activeRun) {
    await endRun($, run, "cancel");

    return;
  }

  // A row with no run behind it (lost in a reload, or a held text): close it.
  if (activeRun === null) {
    heldText = null;
    await resetState($);
  }
};

const stripMarker = (text: string): string => {
  const rest = text.slice(SEND_AS_IS.length);

  return rest.startsWith(" ") ? rest.slice(1) : rest;
};

export const register: Register = (on, options) => {
  const settings = readSettings(options);

  // Fires at the session's start and at every reload: it registers, never
  // resets, so a reload keeps the state.
  on("session.start", async ($, e, next) => {
    await safely(async () => {
      await $.command.register({
        name: COMMAND,
        description: COMMAND_DESCRIPTION,
        argumentHint: COMMAND_HINT,
      });
    });

    return next(e);
  });

  // `/clear` wipes `$.state`: a run under way ends and its prompt goes back.
  on("session.end", ($, e, next) => {
    if (e.reason === "clear") {
      heldText = null;

      if (activeRun !== null) {
        // Back to the box, never sent: the person just cleared the session.
        void safely(() => endRun($, activeRun ?? 0, "restore"));
      }
    }

    return next(e);
  });

  // The guard: the only hook that changes an event, by dropping a caught
  // prompt or an answer, or removing the `>>` marker.
  on("prompt.submit", async ($, e, next) => {
    const isTyped =
      e.origin.kind === "composer" &&
      e.isMeta !== true &&
      e.command === undefined;

    if (isTyped && e.text.startsWith(SEND_AS_IS)) {
      return next({ ...e, text: stripMarker(e.text) });
    }

    // While a question is open, a prompt typed in the box is its answer,
    // also when typed while a turn runs. One with images passes on.
    const answerRun = activeRun;
    const answer = e.text.trim();

    if (
      isTyped &&
      answerRun !== null &&
      answer !== "" &&
      (e.attachments === undefined || e.attachments.length === 0)
    ) {
      let recorded: Recorded | null;

      try {
        recorded = await recordAnswer($, answerRun, null, answer);
      } catch (error) {
        // The answer is half recorded: the run ends and the original goes
        // back to the box; the `.catch` below sends this prompt on.
        void safely(() => endRun($, answerRun, "failed"));
        throw error;
      }

      if (recorded !== null) {
        if (recorded.isLast) {
          void orFail($, answerRun, () => toWriting($, settings, answerRun));
        }

        void safely(() => clearDropped($, e.text));

        return { drop: answerNoted(recorded.number, recorded.total) };
      }
    }

    const isCandidate =
      isTyped &&
      e.turnId === undefined &&
      (e.attachments === undefined || e.attachments.length === 0) &&
      activeRun === null &&
      e.text.trim().length >= settings.minLength;

    if (!isCandidate) {
      return next(e);
    }

    // Decided here: should this throw, the `.catch` below sends the prompt.
    if (!(await startRun($, settings, e.text))) {
      return next(e);
    }

    void safely(() => clearDropped($, e.text));

    return { drop: TEXT_DROP };
  }).catch(($, e, next) => {
    // The prompt is sent after all: a run started for it must not bring a
    // brief later as well.
    if (activeRun !== null && original === e.text) {
      abandonRun(activeRun);
      void safely(() => resetState($));
    }

    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($, e) => {
    const text = e.args.trim();

    if (text === "") {
      return { text: TEXT_USAGE, isTextDisplayOnly: true };
    }

    const isStarted = await startRun($, settings, text);

    return {
      text: isStarted ? TEXT_STARTED : TEXT_BUSY,
      isTextDisplayOnly: true,
    };
  }).catch(() => ({
    text: TEXT_NOT_STARTED,
    isTextDisplayOnly: true as const,
  }));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const step: Step = await read($, stepAtom);

    if (step === "idle" || e.props.hasSurvey) {
      return next(e);
    }

    const { Box, Button, Text } = $.ui.resolve(e);
    const columns = e.props.bodyColumns;
    // The run this drawing belongs to: a press acts on it alone.
    const run = activeRun;

    const lead = (text: string, color = ACCENT) => (
      <Box flexShrink={1}>
        <Text color={color} wrap="truncate-end">
          {text}
        </Text>
      </Box>
    );
    const button = (key: string, label: string, onPress: () => void) => (
      <Box flexShrink={0} marginLeft={1}>
        <Button key={key} label={label} onPress={onPress} />
      </Box>
    );
    const cancelButton = button(
      "cancel",
      "Cancel",
      () => void safely(() => cancel($, run)),
    );
    const closeButton = button(
      "close",
      "Close",
      () => void safely(() => cancel($, null)),
    );

    if (step === "held") {
      return (
        <Box flexDirection="column" width={columns}>
          <Box flexDirection="row">
            {lead(TEXT_HELD)}
            {closeButton}
          </Box>
          <Text>{heldText ?? ""}</Text>
        </Box>
      );
    }

    if (run === null) {
      // The state outlived the run (a reload): only a way out is left.
      return (
        <Box flexDirection="row" width={columns}>
          {lead(TEXT_LOST, DANGER)}
          {closeButton}
        </Box>
      );
    }

    if (step === "asking") {
      const questions = await read($, questionsAtom);
      const index = await read($, indexAtom);
      const question = questions[index];

      if (question !== undefined) {
        return (
          // Framed in the accent, the question bold on its own line: it is
          // waiting on the person, so it has to stand out from other rows.
          <Box
            flexDirection="column"
            width={columns}
            borderStyle="round"
            borderColor={ACCENT}
            paddingX={1}
          >
            <Text color={ACCENT}>
              {`◇ prompt-shaper · question ${index + 1} of ${questions.length}`}
            </Text>
            <Text bold>
              {question}
            </Text>
            <Text dimColor wrap="truncate-end">
              {TEXT_ANSWER_HINT}
            </Text>
            <Box flexDirection="row">
              {button(
                "skip",
                "Skip",
                () =>
                  void orFail($, run, () =>
                    answerQuestion($, settings, run, index, null),
                  ),
              )}
              {button(
                "skip-all",
                "Skip all",
                () =>
                  void orFail($, run, () =>
                    answerQuestion($, settings, run, index, null, true),
                  ),
              )}
              {cancelButton}
            </Box>
          </Box>
        );
      }
    }

    return (
      <Box flexDirection="row" width={columns}>
        {lead(step === "writing" ? TEXT_WRITING : TEXT_READING)}
        {cancelButton}
      </Box>
    );
  });
};
