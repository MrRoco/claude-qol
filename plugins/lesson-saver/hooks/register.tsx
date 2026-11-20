import { atom, read, update } from "claude-code";
import type { EngineInterface, PluginOptions, Register } from "claude-code";

import type { Target } from "../types";

type Engine = EngineInterface;
type Lesson = { rule: string; suggested: Target };

const DEFAULT_MAX_LENGTH = 400;
const MIN_MAX_LENGTH = 40;
const DEFAULT_MODEL = "haiku";
const MODELS: readonly string[] = ["haiku", "sonnet"];
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 20_000;
// Only the end of Claude's answer goes into the side request.
const ANSWER_TAIL = 2000;
const MAX_RULE = 200;
const DUPLICATE_OVERLAP = 0.7;

const SECTION_TITLE = "Rules from corrections";
const SECTION_HEADING = `## ${SECTION_TITLE}`;

// Theme keys only, never fixed colours.
const ACCENT = "claude";

const SYSTEM = `You decide whether a message corrects an AI coding assistant in a way that should become a
lasting rule. A lasting rule is a preference, convention or mistake to avoid that applies
beyond this one task. One-off instructions, questions and approvals are not. If it is a
lasting correction, write the rule: one imperative sentence, at most 25 words, in the
language of the message, general enough to reuse, with no client names, people's names,
URLs, secrets or one-off details. Say whether it fits this project only or all projects.
Reply with JSON only: {"lasting": true|false, "rule": "...", "scope": "project"|"global"}`;

const TEXT_NO_TARGET = "Could not find where to save this rule.";
const TEXT_SAVE_ERROR = "Could not save the rule";
const TARGET_NAMES: Record<Target, string> = {
  project: "the project CLAUDE.md",
  global: "your global CLAUDE.md",
};
const TEXT_SAVED: Record<Target, string> = {
  project: "Rule saved to the project CLAUDE.md.",
  global: "Rule saved to your global CLAUDE.md.",
};

const lessonAtom = atom(
  { plugin: "lesson-saver", key: "lesson" } as const,
  null,
);
const editingAtom = atom(
  { plugin: "lesson-saver", key: "editing" } as const,
  false,
);
const savingAtom = atom(
  { plugin: "lesson-saver", key: "saving" } as const,
  false,
);

// Module variables, memory only. `lastAnswer` holds the end of Claude's last
// main answer; it is never written or logged and is dropped at /clear.
let lastAnswer: string | null = null;
// Each check gets a number; a slower older check never replaces a newer lesson.
let checkSeq = 0;
let appliedSeq = 0;
// Bumped at /clear and resume, so a check still running then is dropped.
let sessionEpoch = 0;
// Set in the same synchronous step that takes a Save press or opens Edit, so
// a check landing meanwhile does not replace the lesson under the person.
let isSavingNow = false;
let isEditingNow = false;

/** The maxLength option, or 400 when missing, not a number or below 40. */
const readMaxLength = (options: PluginOptions | undefined): number => {
  const value = options?.maxLength;

  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_MAX_LENGTH
    ? value
    : DEFAULT_MAX_LENGTH;
};

/** The model option when it is one of the offered models, else haiku. */
const readModel = (options: PluginOptions | undefined): string => {
  const value = options?.model;

  return typeof value === "string" && MODELS.includes(value)
    ? value
    : DEFAULT_MODEL;
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
    // Observe only. Nothing is logged: prompts and rules may hold client details.
  }
};

/** One line, no list marker, at most 200 characters cut at a word boundary. */
const cleanRule = (raw: string): string => {
  const rule = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*+]\s+/, "");

  if (rule.length <= MAX_RULE) {
    return rule;
  }

  const head = rule.slice(0, MAX_RULE - 1);
  const space = head.lastIndexOf(" ");

  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
};

/** The check's verdict as a lesson, or null when it is no lasting rule or unreadable. */
const parseVerdict = (text: string): Lesson | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end <= start) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  const verdict = value as Record<string, unknown>;

  if (verdict.lasting !== true || typeof verdict.rule !== "string") {
    return null;
  }

  const rule = cleanRule(verdict.rule);

  return rule === ""
    ? null
    : { rule, suggested: verdict.scope === "global" ? "global" : "project" };
};

/** The set of words (3+ letters) of a rule, without punctuation or its date note. */
const ruleWords = (rule: string): Set<string> =>
  new Set(
    rule
      .toLowerCase()
      .replace(/\(added[^)]*\)\s*$/u, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3),
  );

/** Jaccard overlap of the two rules' word sets is at least 0.7. */
const isNearDuplicate = (first: string, second: string): boolean => {
  const firstWords = ruleWords(first);
  const secondWords = ruleWords(second);
  const union = new Set([...firstWords, ...secondWords]);

  if (union.size === 0) {
    return false;
  }

  let shared = 0;

  for (const word of firstWords) {
    if (secondWords.has(word)) {
      shared += 1;
    }
  }

  return shared / union.size >= DUPLICATE_OVERLAP;
};

type Line = { text: string; end: number; hasBreak: boolean };

/** The file's lines, each with the offset just past its line break. */
const splitLines = (text: string): Line[] => {
  const lines: Line[] = [];
  let start = 0;

  while (start < text.length) {
    const lineBreak = text.indexOf("\n", start);
    const stop = lineBreak === -1 ? text.length : lineBreak;
    lines.push({
      text: text.slice(start, stop).replace(/\r$/, ""),
      end: lineBreak === -1 ? text.length : lineBreak + 1,
      hasBreak: lineBreak !== -1,
    });
    start = lineBreak === -1 ? text.length : lineBreak + 1;
  }

  return lines;
};

const FENCE = /^\s{0,3}(```|~~~)/;
const LIST_ITEM = /^[-*+]\s+(.*)$/;

/**
 * Where `## Rules from corrections` stands: its heading line and the line that
 * ends it (the next `#` or `##` heading, or the end). Lines inside code fences
 * are never headings.
 */
const findSection = (
  lines: Line[],
): { heading: number; end: number } | null => {
  let isInFence = false;
  let heading = -1;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]?.text ?? "";

    if (FENCE.test(text)) {
      isInFence = !isInFence;
      continue;
    }

    if (isInFence) {
      continue;
    }

    if (heading === -1) {
      if (/^##\s+Rules from corrections\s*$/i.test(text)) {
        heading = i;
      }
    } else if (/^#{1,2}\s/.test(text)) {
      return { heading, end: i };
    }
  }

  return heading === -1 ? null : { heading, end: lines.length };
};

/** The rules already listed in the file's section. */
const sectionRules = (text: string): string[] => {
  const lines = splitLines(text);
  const section = findSection(lines);

  if (section === null) {
    return [];
  }

  const rules: string[] = [];

  for (let i = section.heading + 1; i < section.end; i++) {
    const match = LIST_ITEM.exec(lines[i]?.text ?? "");

    if (match?.[1] !== undefined) {
      rules.push(match[1]);
    }
  }

  return rules;
};

/**
 * The file with `line` added as the last list line of the section, or the
 * section added at the end. Every byte of the file is kept; only new bytes
 * are inserted, with the file's own line break.
 */
const insertRule = (text: string, line: string): string => {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(text);
  const section = findSection(lines);

  if (section === null) {
    const block = `${SECTION_HEADING}${eol}${eol}${line}${eol}`;

    if (text === "") {
      return block;
    }

    if (text.endsWith(`${eol}${eol}`)) {
      return `${text}${block}`;
    }

    return text.endsWith("\n")
      ? `${text}${eol}${block}`
      : `${text}${eol}${eol}${block}`;
  }

  // The last list item, with any indented lines that continue it.
  let anchor = -1;

  for (let i = section.heading + 1; i < section.end; i++) {
    const current = lines[i]?.text ?? "";

    if (LIST_ITEM.test(current)) {
      anchor = i;
    } else if (anchor === i - 1 && /^\s+\S/.test(current)) {
      anchor = i;
    }
  }

  // No list yet: after the section's last text, one blank line between.
  let isBlankNeeded = false;

  if (anchor === -1) {
    anchor = section.heading;
    isBlankNeeded = true;

    for (let i = section.heading + 1; i < section.end; i++) {
      if ((lines[i]?.text ?? "").trim() !== "") {
        anchor = i;
      }
    }
  }

  const after = lines[anchor];

  if (after === undefined) {
    return text;
  }

  const blank = isBlankNeeded ? eol : "";
  const insert = after.hasBreak
    ? `${blank}${line}${eol}`
    : `${eol}${blank}${line}${eol}`;

  return `${text.slice(0, after.end)}${insert}${text.slice(after.end)}`;
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** `dd-mm-yyyy` in local time. */
const formatDate = (ms: number): string => {
  const date = new Date(ms);

  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
};

/**
 * The one file a target means, built from the session root or HOME and fixed
 * parts only; null when the root or HOME is unknown.
 */
const targetPath = async (
  $: Engine,
  target: Target,
): Promise<string | null> => {
  if (target === "project") {
    const root = (await $.session.root()).replace(/[\\/]+$/, "");

    return root === "" ? null : `${root}/CLAUDE.md`;
  }

  const home = ((await $.env.get("HOME")) ?? "").replace(/[\\/]+$/, "");

  return home === "" ? null : `${home}/.claude/CLAUDE.md`;
};

/** The file's text, or empty when it does not exist yet. */
const readTarget = async ($: Engine, path: string): Promise<string> =>
  (await $.fs.exists(path)) ? await $.fs.read(path) : "";

/** Whether either CLAUDE.md already lists a rule close to this one. */
const isKnownRule = async ($: Engine, rule: string): Promise<boolean> => {
  for (const target of ["project", "global"] as const) {
    try {
      const path = await targetPath($, target);

      if (path === null) {
        continue;
      }

      const known = sectionRules(await readTarget($, path));

      if (known.some((existing) => isNearDuplicate(existing, rule))) {
        return true;
      }
    } catch {
      // An unreadable file holds no rule we can compare with.
    }
  }

  return false;
};

const clearLesson = async ($: Engine): Promise<void> => {
  isEditingNow = false;
  await update($, lessonAtom, () => null);
  await update($, editingAtom, () => false);
};

const resetState = async ($: Engine): Promise<void> => {
  await clearLesson($);
  await update($, savingAtom, () => false);
};

/** Asks the side request about one prompt and offers the rule it drafts. */
const runCheck = async (
  $: Engine,
  model: string,
  prompt: string,
  answer: string,
  seq: number,
  epoch: number,
): Promise<void> => {
  const reply = await $.model.complete({
    model,
    system: SYSTEM,
    prompt: `Assistant's previous answer (end):\n${answer}\n\nMessage:\n${prompt}`,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });

  if (!reply.isAnswered || epoch !== sessionEpoch) {
    return;
  }

  const lesson = parseVerdict(reply.text);

  if (lesson === null || (await isKnownRule($, lesson.rule))) {
    return;
  }

  // Decided in one synchronous step: a press or a newer lesson that landed
  // during the awaits above wins.
  await update($, lessonAtom, (current) => {
    if (
      epoch !== sessionEpoch ||
      seq <= appliedSeq ||
      isSavingNow ||
      isEditingNow
    ) {
      return current;
    }

    appliedSeq = seq;

    return lesson;
  });
};

/**
 * Saves the shown rule in one target. The lesson is taken in one synchronous
 * step, so two presses cannot both write.
 */
const pressSave = async ($: Engine, target: Target): Promise<void> => {
  let taken: Lesson | undefined;
  await update($, lessonAtom, (current) => {
    if (current === null || isSavingNow) {
      return current;
    }

    isSavingNow = true;
    taken = current;

    return current;
  });

  if (taken === undefined) {
    return;
  }

  const lesson = taken;

  try {
    isEditingNow = false;
    await update($, editingAtom, () => false);
    await update($, savingAtom, () => true);

    const path = await targetPath($, target);

    if (path === null) {
      $.ui.toast(TEXT_NO_TARGET);

      return;
    }

    // A read error stops here: an existing file is never overwritten blind.
    const text = await readTarget($, path);

    if (sectionRules(text).some((rule) => isNearDuplicate(rule, lesson.rule))) {
      $.ui.toast(`A rule like this is already in ${TARGET_NAMES[target]}.`);
      await clearLesson($);

      return;
    }

    const line = `- ${lesson.rule} (added ${formatDate(await $.clock.now())})`;
    await $.fs.write(path, insertRule(text, line));
    $.ui.toast(TEXT_SAVED[target]);
    await clearLesson($);
  } catch (error) {
    // The lesson stays, so the person can try again or pick the other file.
    $.ui.toast(`${TEXT_SAVE_ERROR}: ${errorMessage(error)}`);
  } finally {
    isSavingNow = false;
    await safely(async () => {
      await update($, savingAtom, () => false);
    });
  }
};

const pressEdit = async ($: Engine): Promise<void> => {
  if (isSavingNow || (await read($, lessonAtom)) === null) {
    return;
  }

  isEditingNow = true;
  await update($, editingAtom, () => true);
};

const pressCancelEdit = async ($: Engine): Promise<void> => {
  isEditingNow = false;
  await update($, editingAtom, () => false);
};

/** Enter in the field keeps the edited rule, unless it was emptied. */
const submitEdit = async ($: Engine, value: string): Promise<void> => {
  const rule = cleanRule(value);
  await update($, lessonAtom, (current) =>
    current === null || rule === "" || isSavingNow
      ? current
      : { ...current, rule },
  );
  isEditingNow = false;
  await update($, editingAtom, () => false);
};

const pressSkip = async ($: Engine): Promise<void> => {
  if (isSavingNow) {
    return;
  }

  await clearLesson($);
};

export const register: Register = (on, options) => {
  const maxLength = readMaxLength(options);
  const model = readModel(options);

  on("turn.complete", ($, e, next) => {
    if (e.agentId === undefined && e.answer.trim() !== "") {
      lastAnswer = e.answer.slice(-ANSWER_TAIL);
    }

    return next(e);
  });

  // Only a short prompt the person typed, after an answer, is checked; the
  // check runs after the prompt has entered and never holds it up.
  on("prompt.submit", async ($, e, next) => {
    const prompt = e.text.trim();
    const answer = lastAnswer;
    const isChecked =
      e.origin.kind === "composer" &&
      e.isMeta !== true &&
      e.command === undefined &&
      prompt.length >= 1 &&
      prompt.length <= maxLength &&
      answer !== null;
    const result = await next(e);

    if (isChecked && answer !== null && result.drop === undefined) {
      checkSeq += 1;
      const seq = checkSeq;
      const epoch = sessionEpoch;
      // On the clock, so the side request outlives this hook's dispatch.
      $.clock.after(0, () => {
        void safely(() => runCheck($, model, prompt, answer, seq, epoch));
      });
    }

    return result;
  }).catch(($, e, next) => next(e));

  on("session.end", async ($, e, next) => {
    if (e.reason === "clear" || e.reason === "resume") {
      lastAnswer = null;
      sessionEpoch += 1;
      isEditingNow = false;
      await safely(() => resetState($));
    }

    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e);
    }

    const lesson = await read($, lessonAtom);

    if (lesson === null) {
      return next(e);
    }

    const { Box, Button, Input, Text } = $.ui.resolve(e);
    const columns = e.props.bodyColumns;
    const button = (
      key: string,
      label: string,
      onPress: () => void,
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

    if (await read($, savingAtom)) {
      return (
        <Box flexDirection="row" width={columns}>
          <Box flexShrink={0}>
            <Text color={ACCENT}>✎ Saving…</Text>
          </Box>
        </Box>
      );
    }

    if (await read($, editingAtom)) {
      return (
        <Box flexDirection="row" width={columns}>
          <Box flexShrink={0} marginRight={1}>
            <Text color={ACCENT}>✎</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Input
              key="rule"
              value={lesson.rule}
              rows={2}
              autoFocus
              submitLabel="keep"
              onSubmit={(value) => void submitEdit($, value)}
            />
          </Box>
          {button("cancel-edit", "Cancel edit", () => void pressCancelEdit($))}
        </Box>
      );
    }

    const saveButtons = {
      project: button(
        "save-project",
        "Save to project",
        () => void pressSave($, "project"),
        lesson.suggested === "project",
      ),
      global: button(
        "save-global",
        "Save globally",
        () => void pressSave($, "global"),
        lesson.suggested === "global",
      ),
    };
    const other: Target = lesson.suggested === "project" ? "global" : "project";

    return (
      <Box flexDirection="row" width={columns}>
        <Box flexShrink={1}>
          <Text color={ACCENT} wrap="truncate-end">
            {`✎ Lesson: ${lesson.rule}`}
          </Text>
        </Box>
        {saveButtons[lesson.suggested]}
        {saveButtons[other]}
        {button("edit", "Edit", () => void pressEdit($))}
        {button("skip", "Skip", () => void pressSkip($))}
      </Box>
    );
  });
};
