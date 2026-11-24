import type { EngineInterface, PluginOptions, Register } from "claude-code";

type Engine = EngineInterface;

const ANSWER_ONCE = "Allow once";
const ANSWER_DENY = "Deny";
const TEXT_FAILED = "repo-fence could not check this change; it was refused.";
// Stands in for a path or root the failed check never got to know.
const UNKNOWN = "unknown";

// Folders Claude Code and the system use for scratch work; never asked.
const TEMP_FOLDERS = ["/tmp", "/private/tmp", "/var/folders"];
// Device files such as /dev/null are a redirect target in many commands and
// change no project, so they never ask either.
const DEVICE_FOLDER = "/dev";
const CLAUDE_FOLDER = "/.claude/";

// Commands that only read: their path arguments never ask.
const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "grep",
  "rg",
  "find",
  "wc",
  "stat",
  "file",
  "diff",
  "tree",
  "du",
  "echo",
  "printf",
  "which",
]);
const READ_ONLY_GIT = new Set(["log", "show", "diff", "status", "blame"]);
// Shell keywords that may lead a segment before its real command.
const LEADING_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
  "time",
]);

// Module variables, never written to disk or logged.
// Folders the person allowed for the rest of this session.
const sessionAllowed = new Set<string>();
// Questions still open, per folder: a second call for the same folder waits
// for that answer instead of opening a second dialog.
const openAsks = new Map<string, Promise<Answer>>();

type Answer = "once" | "folder" | "deny";

/** A place a call would change, and the folder the question is about. */
type Target = { path: string; folder: string };

type Context = {
  root: string;
  home: string | null;
  // `allowedPaths` from the settings, made absolute.
  allowedFolders: string[];
};

/** A word of a shell segment, quotes removed. */
type Word = { text: string; isRedirectTarget: boolean };

const denyText = (path: string, root: string): string =>
  `repo-fence: ${path} is outside this session's repository (${root}) and was not allowed. To work there, ask the person to open a Claude Code session in that folder.`;

const questionText = (path: string, root: string): string =>
  `repo-fence: Claude wants to change ${path}, outside this session's repository (${root}). Allow it?`;

const folderAnswer = (folder: string): string =>
  `Allow ${folder} for this session`;

/** The home folder read off the root (`/Users/<name>`, `/home/<name>`). */
const homeFromRoot = (root: string): string | null => {
  const match = /^\/(?:Users|home)\/[^/]+/.exec(root);

  return match === null ? null : match[0];
};

/** `.`, `..` and double slashes resolved in an absolute path. */
const normaliseAbsolute = (path: string): string => {
  const parts: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return `/${parts.join("/")}`;
};

/**
 * The path made absolute: `~/` from the home folder, a relative one against
 * the root. Null for a `~` path when the home folder is unknown.
 */
const resolvePath = (path: string, context: Context): string | null => {
  if (path === "~" || path.startsWith("~/")) {
    return context.home === null
      ? null
      : normaliseAbsolute(`${context.home}/${path.slice(1)}`);
  }

  return normaliseAbsolute(
    path.startsWith("/") ? path : `${context.root}/${path}`,
  );
};

const isWithin = (path: string, folder: string): boolean =>
  folder === "/" || path === folder || path.startsWith(`${folder}/`);

/** Whether a change at this absolute path needs no question. */
const isAllowed = (path: string, context: Context): boolean =>
  isWithin(path, context.root) ||
  path.includes(CLAUDE_FOLDER) ||
  path.endsWith("/.claude") ||
  TEMP_FOLDERS.some((folder) => isWithin(path, folder)) ||
  isWithin(path, DEVICE_FOLDER) ||
  context.allowedFolders.some((folder) => isWithin(path, folder)) ||
  [...sessionAllowed].some((folder) => isWithin(path, folder));

const parentOf = (path: string): string => {
  const cut = path.lastIndexOf("/");

  return cut <= 0 ? "/" : path.slice(0, cut);
};

/**
 * The target for a path as written, or null when it needs no question. A
 * `~` path whose home is unknown counts as outside, asked as written.
 */
const targetFor = (
  written: string,
  isDirectory: boolean,
  context: Context,
): Target | null => {
  const path = resolvePath(written, context);

  if (path === null) {
    return { path: written, folder: written };
  }

  if (isAllowed(path, context)) {
    return null;
  }

  // A path written with a trailing slash names a folder.
  const isFolder = isDirectory || /\/$/.test(written);

  return { path, folder: isFolder ? path : parentOf(path) };
};

/** The always-allowed folders of the `allowedPaths` setting. */
const readAllowedFolders = (
  options: PluginOptions | undefined,
  root: string,
  home: string | null,
): string[] => {
  const raw = options?.allowedPaths;

  if (typeof raw !== "string") {
    return [];
  }

  const context: Context = { root, home, allowedFolders: [] };

  return (
    raw
      .split(",")
      .map((entry) => entry.trim())
      // Relative entries are left out: the setting asks for absolute or ~/ ones.
      .filter((entry) => entry.startsWith("/") || entry.startsWith("~"))
      .map((entry) => resolvePath(entry, context))
      .filter((entry): entry is string => entry !== null)
  );
};

/**
 * Removes heredoc bodies, so the text fed to a command is never read as
 * commands. Everything up to the end of the line with `<<` stays.
 */
const stripHeredocs = (command: string): string => {
  let output = "";
  let quote: "'" | '"' | null = null;
  const pending: string[] = [];
  let i = 0;

  while (i < command.length) {
    const char = command[i] ?? "";

    if (quote !== null) {
      output += char;

      if (char === "\\" && quote === '"') {
        output += command[i + 1] ?? "";
        i += 2;
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      i += 1;
      continue;
    }

    if (char === "\\") {
      output += char + (command[i + 1] ?? "");
      i += 2;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      i += 1;
      continue;
    }

    if (command.startsWith("<<", i) && command[i + 2] !== "<") {
      const marker =
        /^<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(
          command.slice(i),
        );

      if (marker !== null) {
        pending.push(marker[1] ?? marker[2] ?? marker[3] ?? "");
        output += marker[0];
        i += marker[0].length;
        continue;
      }
    }

    if (char === "\n" && pending.length > 0) {
      output += char;
      i += 1;

      // Skip each body up to its own end line; an unended body runs to the end.
      for (const delimiter of pending) {
        while (i < command.length) {
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end === -1 ? command.length : end);
          i = end === -1 ? command.length : end + 1;

          if (line.trim() === delimiter) {
            break;
          }
        }
      }

      pending.length = 0;
      continue;
    }

    output += char;
    i += 1;
  }

  return output;
};

/**
 * Splits a command into segments on `&&`, `||`, `;`, `|`, a lone `&` and new
 * lines, outside quotes and `$( … )`. Comments are dropped.
 */
const splitSegments = (command: string): string[] => {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let i = 0;

  const push = (): void => {
    segments.push(current);
    current = "";
  };

  while (i < command.length) {
    const char = command[i] ?? "";
    const nextChar = command[i + 1] ?? "";

    if (quote === "'") {
      current += char;
      quote = char === "'" ? null : quote;
      i += 1;
      continue;
    }

    if (char === "\\") {
      current += char + nextChar;
      i += 2;
      continue;
    }

    if (quote === '"') {
      current += char;
      quote = char === '"' ? null : quote;
      i += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      i += 1;
      continue;
    }

    if (char === "$" && nextChar === "(") {
      depth += 1;
      current += "$(";
      i += 2;
      continue;
    }

    if (char === ")" && depth > 0) {
      depth -= 1;
      current += char;
      i += 1;
      continue;
    }

    if (depth > 0) {
      current += char;
      i += 1;
      continue;
    }

    const previous = command[i - 1] ?? "";

    if (char === "#" && (current === "" || /\s/.test(previous))) {
      const end = command.indexOf("\n", i);
      i = end === -1 ? command.length : end;
      continue;
    }

    if (
      (char === "&" && nextChar === "&") ||
      (char === "|" && nextChar === "|")
    ) {
      push();
      i += 2;
      continue;
    }

    // A lone `&` sends a command to the background; `>&`, `&>` redirect.
    const isLoneAmpersand =
      char === "&" && previous !== ">" && nextChar !== ">";

    if (char === ";" || char === "\n" || char === "|" || isLoneAmpersand) {
      // `>|` forces a redirect over an existing file: not a pipe.
      if (char === "|" && previous === ">") {
        current += char;
        i += 1;
        continue;
      }

      push();
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  push();

  return segments.filter((segment) => segment.trim() !== "");
};

/**
 * The words of one segment, quotes removed. A word after `>` or `>>` is
 * marked as a redirect target; `<` only ends a word.
 */
const splitWords = (segment: string): Word[] => {
  const words: Word[] = [];
  let current = "";
  let hasWord = false;
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let isRedirect = false;
  let i = 0;

  const push = (): void => {
    if (hasWord) {
      words.push({ text: current, isRedirectTarget: isRedirect });
      isRedirect = false;
    }

    current = "";
    hasWord = false;
  };

  while (i < segment.length) {
    const char = segment[i] ?? "";
    const nextChar = segment[i + 1] ?? "";

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }

      i += 1;
      continue;
    }

    if (char === "\\") {
      current += nextChar;
      hasWord = true;
      i += 2;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }

      i += 1;
      continue;
    }

    if (depth > 0) {
      depth += char === "(" ? 1 : char === ")" ? -1 : 0;
      current += char;
      i += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
      i += 1;
      continue;
    }

    if (char === "$" && nextChar === "(") {
      depth = 1;
      current += "$(";
      hasWord = true;
      i += 2;
      continue;
    }

    if (char === ">") {
      // A file descriptor (`2>`) or `&>` in front belongs to the operator.
      if (/^(?:\d+|&)$/.test(current)) {
        current = "";
        hasWord = false;
      }

      push();
      i += nextChar === ">" || nextChar === "|" ? 2 : 1;

      // `>&2` duplicates a descriptor: no file is written.
      if (segment[i] === "&") {
        i += 1;
        while (i < segment.length && /[\w-]/.test(segment[i] ?? "")) {
          i += 1;
        }
        continue;
      }

      isRedirect = true;
      continue;
    }

    if (/\s/.test(char) || char === "<") {
      push();
      i += 1;
      continue;
    }

    current += char;
    hasWord = true;
    i += 1;
  }

  push();

  return words;
};

const isPathWord = (text: string): boolean =>
  text.startsWith("/") || text === "~" || text.startsWith("~/");

const baseName = (word: string): string =>
  word.slice(word.lastIndexOf("/") + 1);

/** Where `git` would run, from each `-C <dir>`; and its subcommand. */
const readGit = (
  words: readonly Word[],
): { dirs: string[]; dirIndexes: Set<number>; subcommand: string | null } => {
  const dirs: string[] = [];
  const dirIndexes = new Set<number>();

  for (let i = 1; i < words.length; i += 1) {
    const text = words[i]?.text ?? "";

    if (text === "-C" || text === "-c") {
      const value = words[i + 1]?.text;

      if (text === "-C" && value !== undefined) {
        dirs.push(value);
        dirIndexes.add(i + 1);
      }

      i += 1;
      continue;
    }

    if (!text.startsWith("-")) {
      return { dirs, dirIndexes, subcommand: text };
    }
  }

  return { dirs, dirIndexes, subcommand: null };
};

/** The places one shell segment would change outside the repository. */
const segmentTargets = (segment: string, context: Context): Target[] => {
  const words = splitWords(segment.replace(/^[\s({]+/, ""));
  const targets: Target[] = [];
  const add = (target: Target | null): void => {
    if (target !== null) {
      targets.push(target);
    }
  };

  // Redirects write a file, whatever the command.
  for (const word of words) {
    if (word.isRedirectTarget && !word.text.startsWith("$(")) {
      add(targetFor(word.text, false, context));
    }
  }

  const commandWords = words.filter((word) => !word.isRedirectTarget);
  let start = 0;

  while (LEADING_KEYWORDS.has(commandWords[start]?.text ?? "")) {
    start += 1;
  }

  const rest = commandWords.slice(start);
  const first = baseName(rest[0]?.text ?? "");

  if (first === "cd" || first === "pushd") {
    const dir = rest.slice(1).find((word) => !word.text.startsWith("-"));

    if (dir !== undefined) {
      add(targetFor(dir.text, true, context));
    }

    return targets;
  }

  let skipped = new Set<number>();
  let isReadOnly = READ_ONLY_COMMANDS.has(first);

  if (first === "git") {
    const git = readGit(rest);

    for (const dir of git.dirs) {
      add(targetFor(dir, true, context));
    }

    skipped = git.dirIndexes;
    isReadOnly = git.subcommand !== null && READ_ONLY_GIT.has(git.subcommand);
  }

  if (isReadOnly) {
    return targets;
  }

  // The command word itself (`/usr/bin/env`) is what runs, not a target.
  rest.forEach((word, index) => {
    if (index === 0 || skipped.has(index)) {
      return;
    }

    // `--prefix=/elsewhere` names a path after the `=`.
    const value = word.text.startsWith("-")
      ? word.text.slice(word.text.indexOf("=") + 1)
      : word.text;

    if (word.text.startsWith("-") && !word.text.includes("=")) {
      return;
    }

    if (isPathWord(value)) {
      add(targetFor(value, false, context));
    }
  });

  return targets;
};

/** The places a Bash command would change outside the repository. */
const bashTargets = (command: string, context: Context): Target[] =>
  splitSegments(stripHeredocs(command)).flatMap((segment) =>
    segmentTargets(segment, context),
  );

/** The person's answer, or deny when the dialog is dismissed or cannot show. */
const askPerson = async (
  $: Engine,
  target: Target,
  root: string,
): Promise<Answer> => {
  try {
    const answer = await $.ui.ask(questionText(target.path, root), [
      ANSWER_ONCE,
      folderAnswer(target.folder),
      ANSWER_DENY,
    ]);

    if (answer === ANSWER_ONCE) {
      return "once";
    }

    // Free text typed under "Other" is no permission.
    return answer === folderAnswer(target.folder) ? "folder" : "deny";
  } catch {
    // Dismissed, or no one to ask (a `-p` run): the safe side.
    return "deny";
  }
};

/**
 * The answer for this folder: the open question's when one is open, else a
 * new one. Checked and set without an await in between, so parallel calls
 * share one dialog.
 */
const answerFor = (
  $: Engine,
  target: Target,
  root: string,
): Promise<Answer> => {
  const open = openAsks.get(target.folder);

  if (open !== undefined) {
    return open;
  }

  const asking = askPerson($, target, root).then((answer) => {
    // Recorded before the question is closed, so a call that comes after the
    // answer finds the folder allowed instead of asking again.
    if (answer === "folder") {
      sessionAllowed.add(target.folder);
    }

    openAsks.delete(target.folder);

    return answer;
  });
  openAsks.set(target.folder, asking);

  return asking;
};

/** The places a call would change, before any allow-list check. */
const callTargets = (
  e: { tool: string; [key: string]: unknown },
  context: Context,
): Target[] => {
  const field =
    e.tool === "Bash"
      ? "command"
      : e.tool === "NotebookEdit"
        ? "notebook_path"
        : "file_path";
  const value = e[field];

  if (typeof value !== "string") {
    // A call with no path to read cannot be checked: refused below.
    throw new Error(`no ${field}`);
  }

  return e.tool === "Bash"
    ? bashTargets(value, context)
    : [targetFor(value, false, context)].filter(
        (target): target is Target => target !== null,
      );
};

/** The path a refused call names, for the deny text when the check failed. */
const writtenPath = (e: { [key: string]: unknown }): string => {
  for (const field of ["file_path", "notebook_path", "command"]) {
    const value = e[field];

    if (typeof value === "string") {
      return value;
    }
  }

  return UNKNOWN;
};

const toastFailure = ($: Engine): void => {
  try {
    $.ui.toast(TEXT_FAILED);
  } catch {
    // The refusal stands without the toast.
  }
};

export const register: Register = (on, options) => {
  // `/clear` starts a fresh session: its allowed folders start empty too.
  on("session.end", ($, e, next) => {
    if (e.reason === "clear") {
      sessionAllowed.clear();
    }

    return next(e);
  });

  on(
    "tool.call",
    { tool: ["Edit", "Write", "NotebookEdit", "Bash"] },
    async ($, e, next) => {
      const input = e as unknown as { tool: string; [key: string]: unknown };
      let root = UNKNOWN;
      let targets: Target[];

      try {
        root = normaliseAbsolute(await $.session.root());
        const home = homeFromRoot(root);
        const context: Context = {
          root,
          home,
          allowedFolders: readAllowedFolders(options, root, home),
        };
        targets = callTargets(input, context);
      } catch {
        // A bug never lets a change through unchecked: refuse it.
        toastFailure($);

        return { deny: denyText(writtenPath(input), root) };
      }

      // Once per folder per call: a second path there rides on the answer.
      const answered = new Set<string>();

      for (const target of targets) {
        // Checked again before each question: an earlier answer may cover it.
        const isCovered =
          answered.has(target.folder) ||
          [...sessionAllowed].some((folder) => isWithin(target.path, folder));

        if (isCovered) {
          continue;
        }

        if ((await answerFor($, target, root)) === "deny") {
          return { deny: denyText(target.path, root) };
        }

        answered.add(target.folder);
      }

      return next(e);
    },
  ).catch(($, e, next) => {
    if (next.called) {
      // The check had passed; what failed came from beneath.
      return next(e);
    }

    toastFailure($);

    return {
      deny: denyText(
        writtenPath(e as unknown as { [key: string]: unknown }),
        UNKNOWN,
      ),
    };
  });
};
