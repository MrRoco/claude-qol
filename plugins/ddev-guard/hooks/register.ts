import type { Register } from "claude-code";

// Where `ddev exec` runs by default inside the web container.
const CONTAINER_ROOT = "/var/www/html";
const DDEV_CONFIG = ".ddev/config.yaml";

// First words that start host PHP tooling. Anything else (ddev, sudo, env,
// command, exec, an assignment like FOO=1, a quoted word) never matches.
const PHP_TOOL = /^(?:php|composer|\.\/artisan|(?:\.\/)?vendor\/bin\/[^/\s]+)$/;
// A folder `cd` may name for `--dir`: relative, plain characters only, so it
// needs no quoting in the rewritten command.
const PLAIN_FOLDER = /^[A-Za-z0-9._\-/]+$/;

// DDEV detection per session root, filled on first use. A module variable,
// never `$.state`: it holds only a path and a yes/no.
const ddevByRoot = new Map<string, boolean>();

type Segment = {
  // Offset of the segment's first non-blank character in the command.
  start: number;
  text: string;
  // The separator that ends the segment: "&&", "||", ";", "|", "\n" or ""
  // at the end of the command.
  separator: string;
};

// Open quoting contexts while parsing: a single or double quote, a
// substitution or subshell "(", a parameter expansion "{" and a backtick.
type Context = "'" | '"' | "(" | "{" | "`";

/** True when `#` at `index` starts a comment: unquoted, at the start of a word. */
const isCommentStart = (command: string, index: number): boolean =>
  index === 0 || /[\s;&|()]/.test(command[index - 1] ?? "");

/**
 * Splits a command into top-level segments. Quotes, `$( … )`, `${ … }`,
 * backticks and subshells `( … )` are kept whole inside their segment, and
 * they nest: a quoted string inside `"$( … )"` stays inside it. Stops at a
 * heredoc marker: the segment holding it and everything after are left out,
 * so a heredoc body is never touched. Stops at a top-level `#` comment: the
 * text before it still counts, nothing after it. Returns null when the
 * command does not parse cleanly (an open quote or bracket, a comment inside
 * a substitution), so the caller passes it unchanged.
 */
const splitSegments = (command: string): Segment[] | null => {
  const segments: Segment[] = [];
  const stack: Context[] = [];
  let segmentStart = 0;

  const close = (end: number, separator: string): void => {
    const raw = command.slice(segmentStart, end);
    const lead = raw.length - raw.trimStart().length;
    segments.push({
      start: segmentStart + lead,
      text: raw.slice(lead),
      separator,
    });
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const nextChar = command[i + 1];
    const top = stack.at(-1);

    if (top === "'") {
      if (char === "'") {
        stack.pop();
      }
      continue;
    }

    if (char === "\\") {
      // Escaped character, including a line continuation: never a separator.
      i += 1;
      continue;
    }

    if (top === '"') {
      // Inside double quotes only the closing quote and new substitutions
      // count; a substitution starts its own quoting.
      if (char === '"') {
        stack.pop();
      } else if (char === "`") {
        stack.push("`");
      } else if (char === "$" && (nextChar === "(" || nextChar === "{")) {
        stack.push(nextChar);
        i += 1;
      }
      continue;
    }

    if (char === "`" && top === "`") {
      stack.pop();
    } else if (char === "'" || char === '"' || char === "`") {
      stack.push(char);
    } else if (char === "$" && nextChar === "{") {
      stack.push("{");
      i += 1;
    } else if (char === "}" && top === "{") {
      stack.pop();
    } else if (char === "<" && nextChar === "<") {
      // A heredoc (or here-string): only the finished segments before it count.
      return segments;
    } else if (char === "#" && isCommentStart(command, i)) {
      if (top !== undefined) {
        // A comment inside a substitution may hide its closing bracket.
        return null;
      }
      close(i, "");
      return segments;
    } else if (char === "(") {
      stack.push("(");
    } else if (char === ")") {
      if (top !== "(") {
        return null;
      }
      stack.pop();
    } else if (top === undefined) {
      if (
        (char === "&" && nextChar === "&") ||
        (char === "|" && nextChar === "|")
      ) {
        close(i, `${char}${nextChar}`);
        i += 1;
        segmentStart = i + 1;
      } else if (char === ";" || char === "|" || char === "\n") {
        close(i, char);
        segmentStart = i + 1;
      }
    }
  }

  if (stack.length !== 0) {
    return null;
  }

  close(command.length, "");

  return segments;
};

/** The first word of a segment, as written. */
const firstWord = (text: string): string => text.split(/\s/, 1)[0] ?? "";

/**
 * A relative path as plain folder names joined by "/" ("" for the folder
 * itself), or null when it holds `..` or anything that would need quoting.
 */
const plainFolder = (path: string): string | null => {
  if (!PLAIN_FOLDER.test(path)) {
    return null;
  }

  const parts = path.split("/").filter((part) => part !== "" && part !== ".");

  if (parts.includes("..")) {
    return null;
  }

  return parts.join("/");
};

/**
 * The folder a `cd` segment moves to, relative to the current folder, or
 * null when it is not a plain relative path.
 */
const cdTarget = (text: string): string | null => {
  const words = text.trim().split(/\s+/);

  if (words.length !== 2) {
    return null;
  }

  const target = words[1] ?? "";

  if (target.startsWith("/")) {
    return null;
  }

  return plainFolder(target);
};

/**
 * The shell's current folder relative to the project root ("" at the root),
 * or null when it lies outside the root or is not a plain folder path.
 */
const folderBelowRoot = (root: string, cwd: string): string | null => {
  const trimmedRoot = root.length > 1 ? root.replace(/\/+$/, "") : root;
  const trimmedCwd = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;

  if (trimmedCwd === trimmedRoot) {
    return "";
  }

  const prefix = trimmedRoot.endsWith("/") ? trimmedRoot : `${trimmedRoot}/`;

  if (!trimmedCwd.startsWith(prefix)) {
    return null;
  }

  return plainFolder(trimmedCwd.slice(prefix.length));
};

const joinFolders = (base: string, target: string): string =>
  [base, target].filter((part) => part !== "").join("/");

/**
 * The command with `ddev exec` in front of each top-level segment that
 * starts host PHP tooling, or null when nothing changes. Only text is added;
 * the segments themselves stay as written.
 */
const rewriteCommand = (command: string, base: string): string | null => {
  const segments = splitSegments(command);

  if (segments === null) {
    return null;
  }

  // The folder below the project root the shell is in: `base` at the start,
  // null once a `cd` went somewhere the container path cannot follow.
  let folder: string | null = base;
  const inserts: { at: number; prefix: string }[] = [];

  for (const segment of segments) {
    const word = firstWord(segment.text);

    if (word === "cd") {
      const target = cdTarget(segment.text);
      folder =
        folder !== null && target !== null && segment.separator === "&&"
          ? joinFolders(folder, target)
          : null;
      continue;
    }

    // After an `||` the shell may be in the folder from before a `cd` or the
    // one after it: unsure, so nothing further is rewritten.
    const isUnsureAfter = segment.separator === "||" && folder !== base;

    if (folder !== null && PHP_TOOL.test(word)) {
      inserts.push({
        at: segment.start,
        prefix:
          folder === ""
            ? "ddev exec "
            : `ddev exec --dir ${CONTAINER_ROOT}/${folder} `,
      });
    }

    if (isUnsureAfter) {
      folder = null;
    }
  }

  if (inserts.length === 0) {
    return null;
  }

  let rewritten = command;

  // From the back, so earlier offsets stay valid.
  for (const insert of [...inserts].reverse()) {
    rewritten =
      rewritten.slice(0, insert.at) +
      insert.prefix +
      rewritten.slice(insert.at);
  }

  return rewritten;
};

/** Tries the rewrite; any parser error means the command passes unchanged. */
const safeRewrite = (command: unknown, base: string): string | null => {
  if (typeof command !== "string") {
    return null;
  }

  try {
    return rewriteCommand(command, base);
  } catch {
    // Nothing is logged: the command may hold client details.
    return null;
  }
};

const noteFor = (original: string, rewritten: string): string =>
  `ddev-guard: this is a DDEV project, so "${original}" ran as "${rewritten}". Run PHP, Composer and vendor/bin tools with ddev exec.`;

export const register: Register = (on) => {
  // Only Bash: a matcher-less `tool.call` hook would slow every tool. The
  // `.catch` relies on `next` being replay-safe there: not called yet, the
  // original command runs once; called, the settled result comes back and
  // nothing runs again. So a bug never blocks a command or runs it twice.
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const root = await $.session.root();
    let isDdev = ddevByRoot.get(root);

    if (isDdev === undefined) {
      isDdev = await $.fs.exists(`${root}/${DDEV_CONFIG}`);
      ddevByRoot.set(root, isDdev);
    }

    if (!isDdev) {
      return next(e);
    }

    // The shell's folder decides `--dir`; outside the project root, or when
    // it cannot be read, the container path cannot follow, so pass unchanged.
    let base: string | null;

    try {
      base = folderBelowRoot(root, await $.session.cwd());
    } catch {
      base = null;
    }

    if (base === null) {
      return next(e);
    }

    // Decided after the last await, so the rewrite is settled exactly once.
    const original = e.command;
    const rewritten = safeRewrite(original, base);

    if (rewritten === null) {
      return next(e);
    }

    const result = await next({ ...e, command: rewritten });

    if (result.deny !== undefined) {
      return result;
    }

    return {
      ...result,
      context: [...(result.context ?? []), noteFor(original, rewritten)],
    };
  }).catch(($, e, next) => next(e));
};
