import type { PluginOptions, Register } from "claude-code";

const DEFAULT_MAX_SUBJECT_LENGTH = 72;
const LOWEST_MAX_SUBJECT_LENGTH = 50;
// Nested `$( … )` deeper than this is refused by the parser: the call passes.
const MAX_DEPTH = 16;

const NOTE_REMOVED =
  "commit-clean removed AI attribution lines from the commit message. Leave them out of commit messages in this project.";

const SUBJECT_PATTERN =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: \S/;
// A summary that reports what was done instead of saying what the commit does.
const PAST_TENSE_START =
  /^(added|adds|fixed|fixes|updated|updates|removed|removes|changed|changes)\b/i;

const denyText = (subject: string, maxLength: number): string =>
  `commit-clean: the subject "${subject}" is not in the project's commit format. ` +
  `Use "type(scope): summary" in the imperative mood (types: feat, fix, docs, style, ` +
  `refactor, perf, test, build, ci, chore, revert), at most ${maxLength} characters, ` +
  `no period at the end. Nothing was committed.`;

/** Thrown on input the parser does not understand; the call then passes unchanged. */
class ParseError extends Error {}

type Heredoc = {
  delimiter: string;
  isQuoted: boolean;
  // The body's lines, each with its newline, without the delimiter line.
  bodyStart: number;
  bodyEnd: number;
};

type Segment = { start: number; end: number; heredocs: Heredoc[] };

type PendingHeredoc = {
  delimiter: string;
  isQuoted: boolean;
  isTabStripped: boolean;
};

type Word = { start: number; end: number };

/** A message source of one commit: an `-m` value or a heredoc body. */
type MessagePart = {
  // The text that holds the message lines, as written in the command.
  contentStart: number;
  contentEnd: number;
  rawLines: string[];
  // The same lines as git receives them.
  lines: string[];
  isHeredoc: boolean;
  // The option and its value, removed when no line of the value is left.
  optionStart: number;
  argEnd: number;
  // What stays of a short-option cluster (`-a` of `-am`) when it is removed.
  optionKeep: string;
};

type Edit = { start: number; end: number; text: string };

type Verdict =
  | { kind: "pass" }
  | { kind: "deny"; subject: string }
  | { kind: "rewrite"; command: string };

const PASS: Verdict = { kind: "pass" };

const isBlank = (text: string): boolean => /^\s*$/.test(text);

/** The position after the single-quoted string that starts at `pos`. */
const endOfSingle = (src: string, pos: number): number => {
  const close = src.indexOf("'", pos + 1);

  if (close === -1) {
    throw new ParseError("unterminated single quote");
  }

  return close + 1;
};

/** The position after the backtick substitution that starts at `pos`. */
const endOfBacktick = (src: string, pos: number): number => {
  for (let i = pos + 1; i < src.length; i += 1) {
    if (src[i] === "\\") {
      i += 1;
    } else if (src[i] === "`") {
      return i + 1;
    }
  }

  throw new ParseError("unterminated backtick");
};

/** The position after the double-quoted string that starts at `pos`. */
const endOfDouble = (src: string, pos: number, depth: number): number => {
  let i = pos + 1;

  while (i < src.length) {
    const char = src[i];

    if (char === "\\") {
      i += 2;
    } else if (char === '"') {
      return i + 1;
    } else if (char === "$" && src[i + 1] === "(") {
      i = scan(src, i + 2, true, depth + 1).end;
    } else if (char === "`") {
      i = endOfBacktick(src, i);
    } else {
      i += 1;
    }
  }

  throw new ParseError("unterminated double quote");
};

/** Reads a heredoc delimiter word: quotes removed, `isQuoted` when it had any. */
const readDelimiter = (
  src: string,
  pos: number,
): { delimiter: string; isQuoted: boolean; end: number } => {
  let i = pos;
  let delimiter = "";
  let isQuoted = false;

  while (i < src.length && !/[\s;&|<>()]/.test(src[i] ?? "")) {
    const char = src[i] ?? "";

    if (char === "'" || char === '"') {
      const close = src.indexOf(char, i + 1);

      if (close === -1) {
        throw new ParseError("unterminated heredoc delimiter");
      }

      delimiter += src.slice(i + 1, close);
      isQuoted = true;
      i = close + 1;
    } else if (char === "\\") {
      delimiter += src[i + 1] ?? "";
      isQuoted = true;
      i += 2;
    } else {
      delimiter += char;
      i += 1;
    }
  }

  if (delimiter === "") {
    throw new ParseError("heredoc without delimiter");
  }

  return { delimiter, isQuoted, end: i };
};

/**
 * Splits shell text into segments on `&&`, `||`, `;`, `|`, `&` and newlines,
 * outside quotes, substitutions and heredoc bodies. A heredoc's body belongs to
 * the segment whose line opened it. In `isSubst` mode it reads the inside of a
 * `$( … )` and returns the position after its closing parenthesis.
 */
const scan = (
  src: string,
  start: number,
  isSubst: boolean,
  depth: number,
): { end: number; segments: Segment[] } => {
  if (depth > MAX_DEPTH) {
    throw new ParseError("nested too deep");
  }

  const segments: Segment[] = [];
  let segmentStart = start;
  let heredocs: Heredoc[] = [];
  let pending: PendingHeredoc[] = [];
  let parens = 0;
  let pos = start;

  const closeSegment = (end: number, next: number): void => {
    segments.push({ start: segmentStart, end, heredocs });
    heredocs = [];
    segmentStart = next;
  };

  // Reads the bodies of the heredocs opened on the line that ended at `pos`.
  const readBodies = (from: number): number => {
    let lineStart = from;

    for (const heredoc of pending) {
      const bodyStart = lineStart;
      let isClosed = false;

      while (!isClosed) {
        if (lineStart > src.length) {
          throw new ParseError("unterminated heredoc");
        }

        const newline = src.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? src.length : newline;
        const line = src.slice(lineStart, lineEnd);
        const compared = heredoc.isTabStripped
          ? line.replace(/^\t+/, "")
          : line;

        if (compared === heredoc.delimiter) {
          heredocs.push({
            delimiter: heredoc.delimiter,
            isQuoted: heredoc.isQuoted,
            bodyStart,
            bodyEnd: lineStart,
          });
          isClosed = true;
        } else if (newline === -1) {
          throw new ParseError("unterminated heredoc");
        }

        lineStart = lineEnd + 1;
      }
    }

    pending = [];

    return Math.min(lineStart, src.length);
  };

  while (pos < src.length) {
    const char = src[pos];
    const nextChar = src[pos + 1];

    if (char === "\\") {
      pos += 2;
    } else if (char === "'") {
      pos = endOfSingle(src, pos);
    } else if (char === '"') {
      pos = endOfDouble(src, pos, depth);
    } else if (char === "`") {
      pos = endOfBacktick(src, pos);
    } else if (char === "$" && nextChar === "(") {
      pos = scan(src, pos + 2, true, depth + 1).end;
    } else if (
      char === "#" &&
      (pos === start || /[\s;&|(]/.test(src[pos - 1] ?? ""))
    ) {
      const newline = src.indexOf("\n", pos);
      pos = newline === -1 ? src.length : newline;
    } else if (char === "<" && nextChar === "<") {
      if (src[pos + 2] === "<") {
        pos += 3;
        continue;
      }

      pos += 2;
      const isTabStripped = src[pos] === "-";

      if (isTabStripped) {
        pos += 1;
      }

      while (src[pos] === " " || src[pos] === "\t") {
        pos += 1;
      }

      const read = readDelimiter(src, pos);
      pending.push({
        delimiter: read.delimiter,
        isQuoted: read.isQuoted,
        isTabStripped,
      });
      pos = read.end;
    } else if (char === "(") {
      parens += 1;
      pos += 1;
    } else if (char === ")") {
      if (parens === 0) {
        if (!isSubst || pending.length > 0) {
          throw new ParseError("unbalanced parenthesis");
        }

        closeSegment(pos, pos + 1);

        return { end: pos + 1, segments };
      }

      parens -= 1;
      pos += 1;
    } else if (char === "\n") {
      const after = pending.length > 0 ? readBodies(pos + 1) : pos + 1;
      closeSegment(pos, after);
      pos = after;
    } else if (char === ";") {
      closeSegment(pos, pos + 1);
      pos += 1;
    } else if (char === "&") {
      const previous = src[pos - 1];

      if (nextChar === "&") {
        closeSegment(pos, pos + 2);
        pos += 2;
      } else if (previous === ">" || previous === "<" || nextChar === ">") {
        // A redirection such as `2>&1` or `&>file`, not a separator.
        pos += 1;
      } else {
        closeSegment(pos, pos + 1);
        pos += 1;
      }
    } else if (char === "|") {
      const width = nextChar === "|" || nextChar === "&" ? 2 : 1;
      closeSegment(pos, pos + width);
      pos += width;
    } else {
      pos += 1;
    }
  }

  if (isSubst || pending.length > 0) {
    throw new ParseError("unterminated command");
  }

  closeSegment(src.length, src.length);

  return { end: src.length, segments };
};

/** The words of a segment, split on unquoted whitespace. */
const wordsOf = (src: string, segment: Segment): Word[] => {
  const words: Word[] = [];
  let pos = segment.start;
  let wordStart = -1;

  while (pos < segment.end) {
    const char = src[pos] ?? "";

    if (/\s/.test(char)) {
      if (wordStart !== -1) {
        words.push({ start: wordStart, end: pos });
        wordStart = -1;
      }

      pos += 1;
      continue;
    }

    if (wordStart === -1) {
      // A comment runs to the segment's end: its words are no arguments.
      if (char === "#") {
        break;
      }

      wordStart = pos;
    }

    if (char === "\\") {
      pos += 2;
    } else if (char === "'") {
      pos = endOfSingle(src, pos);
    } else if (char === '"') {
      pos = endOfDouble(src, pos, 0);
    } else if (char === "`") {
      pos = endOfBacktick(src, pos);
    } else if (char === "$" && src[pos + 1] === "(") {
      pos = scan(src, pos + 2, true, 1).end;
    } else {
      pos += 1;
    }
  }

  if (wordStart !== -1) {
    words.push({ start: wordStart, end: Math.min(pos, segment.end) });
  }

  return words;
};

/** A double-quoted line as the shell passes it on, or null when it expands something. */
const decodeDoubleQuoted = (raw: string): string | null => {
  let decoded = "";

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] ?? "";

    if (char === "\\") {
      const escaped = raw[i + 1];

      if (escaped === undefined) {
        // A line continuation: the shell joins two lines, the parser does not.
        return null;
      }

      decoded += /[$`"\\]/.test(escaped) ? escaped : `\\${escaped}`;
      i += 1;
    } else if (char === "$" || char === "`") {
      return null;
    } else {
      decoded += char;
    }
  }

  return decoded;
};

/** A word as the shell passes it on, or null when it expands something. */
const decodeWord = (raw: string): string | null => {
  let decoded = "";
  let i = 0;

  while (i < raw.length) {
    const char = raw[i] ?? "";

    if (char === "\\") {
      decoded += raw[i + 1] ?? "";
      i += 2;
    } else if (char === "'") {
      const close = raw.indexOf("'", i + 1);

      if (close === -1) {
        return null;
      }

      decoded += raw.slice(i + 1, close);
      i = close + 1;
    } else if (char === '"') {
      const close = endOfDouble(raw, i, 0);
      const inner = decodeDoubleQuoted(raw.slice(i + 1, close - 1));

      if (inner === null) {
        return null;
      }

      decoded += inner;
      i = close;
    } else if (char === "$" || char === "`") {
      return null;
    } else {
      decoded += char;
      i += 1;
    }
  }

  return decoded;
};

const REDIRECT = /^\d*(<<-?|<<<|<>|<&|>&|>>|>\||<|>|&>>|&>)/;

/** A heredoc body as lines, or null when the shell would expand something in it. */
const heredocLines = (src: string, heredoc: Heredoc): string[] | null => {
  const body = src.slice(heredoc.bodyStart, heredoc.bodyEnd);

  if (!heredoc.isQuoted && /[$`\\]/.test(body)) {
    return null;
  }

  return body === "" ? [] : body.replace(/\n$/, "").split("\n");
};

const heredocPart = (src: string, heredoc: Heredoc): MessagePart | null => {
  const lines = heredocLines(src, heredoc);

  if (lines === null) {
    return null;
  }

  return {
    contentStart: heredoc.bodyStart,
    contentEnd: heredoc.bodyEnd,
    rawLines: lines,
    lines,
    isHeredoc: true,
    optionStart: heredoc.bodyStart,
    argEnd: heredoc.bodyEnd,
    optionKeep: "",
  };
};

/**
 * The message part of an `-m` value written from `valueStart` to the end of
 * `word`, or null when its form is not one the parser knows.
 */
const messagePart = (
  src: string,
  word: Word,
  valueStart: number,
  optionStart: number,
  optionKeep: string,
): MessagePart | null => {
  const raw = src.slice(valueStart, word.end);
  const base = { optionStart, argEnd: word.end, optionKeep };

  // `"$(cat <<'EOF' … EOF )"`: the heredoc body is the message.
  if (/^"\$\(\s*cat\s+<</.test(raw)) {
    const inner = scan(src, valueStart + 3, true, 1);

    if (inner.end !== word.end - 1 || src[inner.end] !== '"') {
      return null;
    }

    const heredocs = inner.segments.flatMap((segment) => segment.heredocs);
    const commands = inner.segments.filter(
      (segment) => !isBlank(src.slice(segment.start, segment.end)),
    );
    const heredoc = heredocs[0];

    if (
      heredoc === undefined ||
      heredocs.length !== 1 ||
      commands.length !== 1 ||
      !/^\s*cat\s+<<-?\s*\S+\s*$/.test(
        src.slice(commands[0]?.start ?? 0, commands[0]?.end ?? 0),
      )
    ) {
      return null;
    }

    const part = heredocPart(src, heredoc);

    return part === null ? null : { ...part, ...base };
  }

  if (raw.startsWith('"') && endOfDouble(src, valueStart, 0) === word.end) {
    const rawLines = src.slice(valueStart + 1, word.end - 1).split("\n");
    const lines = rawLines.map(decodeDoubleQuoted);

    if (lines.some((line) => line === null)) {
      return null;
    }

    return {
      contentStart: valueStart + 1,
      contentEnd: word.end - 1,
      rawLines,
      lines: lines as string[],
      isHeredoc: false,
      ...base,
    };
  }

  if (raw.startsWith("'") && endOfSingle(src, valueStart) === word.end) {
    const rawLines = src.slice(valueStart + 1, word.end - 1).split("\n");

    return {
      contentStart: valueStart + 1,
      contentEnd: word.end - 1,
      rawLines,
      lines: rawLines,
      isHeredoc: false,
      ...base,
    };
  }

  const decoded = decodeWord(raw);

  if (decoded === null || decoded.includes("\n")) {
    return null;
  }

  // A bare word: never rewritten line by line, only removed as a whole.
  return {
    contentStart: valueStart,
    contentEnd: word.end,
    rawLines: [raw],
    lines: [decoded],
    isHeredoc: false,
    ...base,
  };
};

// Long options whose value may follow as the next word.
const LONG_WITH_VALUE = new Set([
  "--author",
  "--date",
  "--cleanup",
  "--trailer",
  "--pathspec-from-file",
  "--template",
]);
// Options that take the message from elsewhere, or keep the old one.
const LONG_EXCLUDED = new Set([
  "--reuse-message",
  "--reedit-message",
  "--fixup",
  "--squash",
  "--no-edit",
]);

/**
 * The message parts of the segment when it is a `git … commit` whose message
 * the mod checks; null when it is not, or when it passes unchanged.
 */
const commitParts = (src: string, segment: Segment): MessagePart[] | null => {
  const words: { word: Word; value: string | null }[] = [];
  let hasHeredocRedirect = false;
  const all = wordsOf(src, segment);

  for (let i = 0; i < all.length; i += 1) {
    const word = all[i] as Word;
    const raw = src.slice(word.start, word.end);
    const redirect = REDIRECT.exec(raw);

    if (redirect !== null) {
      hasHeredocRedirect ||=
        redirect[1]?.startsWith("<<") === true && redirect[1] !== "<<<";

      if (raw.length === redirect[0].length) {
        i += 1;
      }

      continue;
    }

    words.push({ word, value: decodeWord(raw) });
  }

  if (words[0]?.value !== "git") {
    return null;
  }

  let index = 1;

  while (words[index]?.value === "-C" || words[index]?.value === "-c") {
    index += 2;
  }

  if (words[index]?.value !== "commit") {
    return null;
  }

  const parts: MessagePart[] = [];
  let file: string | null | undefined;

  for (index += 1; index < words.length; index += 1) {
    const { word, value } = words[index] as {
      word: Word;
      value: string | null;
    };
    const raw = src.slice(word.start, word.end);

    if (value === "--") {
      break;
    }

    if (value === null || !value.startsWith("-") || value === "-") {
      continue;
    }

    if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      const name = equals === -1 ? value : value.slice(0, equals);

      if (LONG_EXCLUDED.has(name)) {
        return null;
      }

      if (name === "--message" || name === "--file") {
        let part: MessagePart | null;
        let fileValue: string | null;

        if (equals === -1) {
          const next = words[index + 1];

          if (next === undefined) {
            return null;
          }

          index += 1;
          part =
            name === "--message"
              ? messagePart(src, next.word, next.word.start, word.start, "")
              : null;
          fileValue = next.value;
        } else {
          if (!raw.startsWith(`${name}=`)) {
            return null;
          }

          part =
            name === "--message"
              ? messagePart(
                  src,
                  word,
                  word.start + name.length + 1,
                  word.start,
                  "",
                )
              : null;
          fileValue = value.slice(equals + 1);
        }

        if (name === "--file") {
          file = fileValue;
        } else if (part === null) {
          return null;
        } else {
          parts.push(part);
        }
      } else if (LONG_WITH_VALUE.has(name) && equals === -1) {
        index += 1;
      }

      continue;
    }

    // A short-option cluster such as `-am`: the first option that takes a
    // value takes the rest of the word, or the next word.
    for (let j = 1; j < value.length; j += 1) {
      const flag = value[j] ?? "";

      if (flag === "S" || flag === "u") {
        break;
      }

      if (!"mFCct".includes(flag)) {
        continue;
      }

      if (flag === "C" || flag === "c") {
        return null;
      }

      const isAttached = j + 1 < value.length;
      const next = words[index + 1];

      if (!isAttached && next === undefined) {
        return null;
      }

      if (flag === "m") {
        const prefix = value.slice(0, j + 1);

        if (!raw.startsWith(prefix)) {
          return null;
        }

        const keep = j === 1 ? "" : value.slice(0, j);
        const part = isAttached
          ? messagePart(src, word, word.start + prefix.length, word.start, keep)
          : messagePart(
              src,
              (next as { word: Word }).word,
              (next as { word: Word }).word.start,
              word.start,
              keep,
            );

        if (part === null) {
          return null;
        }

        parts.push(part);
      } else if (flag === "F") {
        file = isAttached ? value.slice(j + 1) : (next?.value ?? null);
      }

      if (!isAttached) {
        index += 1;
      }

      break;
    }
  }

  if (file !== undefined) {
    // Only `-F -` fed by this segment's own heredoc is read; a file is not.
    const heredoc = segment.heredocs[0];

    if (
      file !== "-" ||
      parts.length > 0 ||
      !hasHeredocRedirect ||
      heredoc === undefined ||
      segment.heredocs.length !== 1
    ) {
      return null;
    }

    const part = heredocPart(src, heredoc);

    return part === null ? null : [part];
  }

  // No message given: git opens the editor, nothing to check.
  return parts.length > 0 ? parts : null;
};

/** Whether a message line is an AI attribution line the mod removes. */
const isAttribution = (line: string): boolean => {
  const isClaudeCoAuthor =
    /^\s*co-authored-by:/i.test(line) &&
    (/\bclaude\b/i.test(line) || /@anthropic\.com/i.test(line));
  const isGeneratedLine =
    /generated with/i.test(line) && /claude code/i.test(line);

  return isClaudeCoAuthor || isGeneratedLine;
};

/** The part with attribution lines and then trailing blank lines removed; null when unchanged. */
const cleaned = (
  part: MessagePart,
): { rawLines: string[]; lines: string[] } | null => {
  const rawLines: string[] = [];
  const lines: string[] = [];

  part.lines.forEach((line, i) => {
    if (!isAttribution(line)) {
      rawLines.push(part.rawLines[i] ?? "");
      lines.push(line);
    }
  });

  if (lines.length === part.lines.length) {
    return null;
  }

  while (lines.length > 0 && isBlank(lines[lines.length - 1] ?? "")) {
    lines.pop();
    rawLines.pop();
  }

  return { rawLines, lines };
};

const isGoodSubject = (subject: string, maxLength: number): boolean => {
  const summary = subject.slice(subject.indexOf(": ") + 2);

  return (
    SUBJECT_PATTERN.test(subject) &&
    [...subject].length <= maxLength &&
    !subject.endsWith(".") &&
    !PAST_TENSE_START.test(summary)
  );
};

/** The edit that writes a cleaned part back into the command. */
const editFor = (
  src: string,
  part: MessagePart,
  kept: { rawLines: string[] },
): Edit => {
  if (part.isHeredoc) {
    return {
      start: part.contentStart,
      end: part.contentEnd,
      text: kept.rawLines.map((line) => `${line}\n`).join(""),
    };
  }

  if (kept.rawLines.length > 0) {
    return {
      start: part.contentStart,
      end: part.contentEnd,
      text: kept.rawLines.join("\n"),
    };
  }

  // Nothing left of this `-m`: the option goes, with the space before it.
  if (part.optionKeep !== "") {
    return { start: part.optionStart, end: part.argEnd, text: part.optionKeep };
  }

  let start = part.optionStart;

  while (start > 0 && /[ \t]/.test(src[start - 1] ?? "")) {
    start -= 1;
  }

  return { start, end: part.argEnd, text: "" };
};

/** Decides what happens to a Bash command: pass, refuse, or run rewritten. */
const judge = (command: string, maxLength: number): Verdict => {
  // Cheap first look: most Bash calls are no commit at all.
  if (!/\bgit\b/.test(command) || !command.includes("commit")) {
    return PASS;
  }

  const edits: Edit[] = [];

  for (const segment of scan(command, 0, false, 0).segments) {
    const parts = commitParts(command, segment);

    if (parts === null) {
      continue;
    }

    const paragraphs: string[] = [];

    for (const part of parts) {
      const kept = cleaned(part);

      if (kept !== null) {
        edits.push(editFor(command, part, kept));
      }

      paragraphs.push((kept ?? part).lines.join("\n"));
    }

    const message = paragraphs
      .filter((paragraph) => !isBlank(paragraph))
      .join("\n\n");
    const subject = (message.trimStart().split("\n")[0] ?? "").trim();

    if (!isGoodSubject(subject, maxLength)) {
      return { kind: "deny", subject };
    }
  }

  if (edits.length === 0) {
    return PASS;
  }

  let rewritten = command;

  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    rewritten =
      rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }

  return { kind: "rewrite", command: rewritten };
};

/** The longest subject, falling back to 72 when missing, not a number or below 50. */
const readMaxSubjectLength = (options: PluginOptions | undefined): number => {
  const value = options?.maxSubjectLength;

  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= LOWEST_MAX_SUBJECT_LENGTH
    ? Math.floor(value)
    : DEFAULT_MAX_SUBJECT_LENGTH;
};

export const register: Register = (on, options) => {
  const maxSubjectLength = readMaxSubjectLength(options);

  // The only hook. It changes a call only by removing attribution lines from a
  // commit message, or refuses it for a bad subject; every other call passes.
  on("tool.call", { tool: "Bash" }, async (_, e, next) => {
    if (e.tool !== "Bash" || typeof e.command !== "string") {
      return next(e);
    }

    let verdict: Verdict;

    try {
      verdict = judge(e.command, maxSubjectLength);
    } catch {
      // A parser bug never blocks a commit. Nothing is logged: messages may
      // name people.
      return next(e);
    }

    if (verdict.kind === "deny") {
      return { deny: denyText(verdict.subject, maxSubjectLength) };
    }

    if (verdict.kind === "pass") {
      return next(e);
    }

    const ran = await next({ ...e, command: verdict.command });

    if (ran.deny !== undefined) {
      return ran;
    }

    return { ...ran, context: [...(ran.context ?? []), NOTE_REMOVED] };
  }).catch((_, e, next) => {
    // `next` is replay-safe here: once called, this returns what that call
    // settled to and nothing beneath runs again.
    return next(e);
  });
};
