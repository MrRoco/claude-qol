import { atom, read, update } from "claude-code";
import type {
  EngineInterface,
  Register,
  RenderElement,
  RenderSurface,
} from "claude-code";

import type {
  ConnectorEntry,
  ContextFile,
  FileEntry,
  NameCount,
} from "../types";

const PANE_ID = "chat-ledger";
const PANE_TITLE = "Ledger";
const EMPTY_TEXT = "none yet";

// Theme keys, never fixed colours, so the pane follows the person's theme:
// `claude` is the theme's accent, `error` its danger colour.
const HEADING = "claude";
const DANGER = "error";

// Tool calls asked for but not answered yet, by tool_use id. A call whose
// result never arrives (an abort, a crash) would otherwise stay forever.
const MAX_PENDING_CALLS = 500;

const EDIT_TOOLS: readonly string[] = ["Edit", "MultiEdit", "NotebookEdit"];
const MCP_PREFIX = "mcp__";
const MCP_PROVIDER_PREFIX = "mcp:";

const connectorsAtom = atom(
  { plugin: "chat-ledger", key: "connectors" } as const,
  [],
);
const filesAtom = atom({ plugin: "chat-ledger", key: "files" } as const, []);
const skillsAtom = atom({ plugin: "chat-ledger", key: "skills" } as const, []);
const commandsAtom = atom(
  { plugin: "chat-ledger", key: "commands" } as const,
  [],
);
const contextFilesAtom = atom(
  { plugin: "chat-ledger", key: "contextFiles" } as const,
  [],
);
const expandedAtom = atom(
  { plugin: "chat-ledger", key: "expanded" } as const,
  [],
);

type Engine = EngineInterface;

type FileAction = "read" | "edit" | "write";

/** What the ledger needs of one call until its result row arrives. */
type PendingCall =
  | { kind: "connector"; server: string; tool: string }
  | { kind: "file"; action: FileAction; path: string }
  | { kind: "skill"; skill: string; isPromptSeen: boolean };

type Ledger = {
  connectors: readonly ConnectorEntry[];
  files: readonly FileEntry[];
  skills: readonly NameCount[];
  commands: readonly NameCount[];
  contextFiles: readonly ContextFile[];
};

/** Turns an absolute path into the text the pane and the export show. */
type PathView = (path: string) => string;

// Module state: lost at a reload, which only means a call in flight then is
// counted from its result row alone (connectors) or not at all (files).
const pendingCalls = new Map<string, PendingCall>();
// Tool name → MCP server name as `/mcp` shows it, from `tool.describe`.
const serverByTool = new Map<string, string>();
// The `<server>` part of `mcp__<server>__<tool>` → that same server name.
const serverByPrefix = new Map<string, string>();
// The last command run, until a skill prompt of the same name claims it: a
// `/name` skill raises both, and is listed once, as a skill.
let lastCommand: string | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Runs state work so that a failure never reaches the event it observes. */
const safely = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work();
  } catch {
    // Observe only: a failed update keeps the last good state. Nothing is
    // logged, as paths and names may hold client names.
  }
};

/** Splits `mcp__<server>__<tool>`; undefined for any other name. */
const splitMcpName = (
  name: string,
): { server: string; tool: string } | undefined => {
  if (!name.startsWith(MCP_PREFIX)) {
    return undefined;
  }

  const rest = name.slice(MCP_PREFIX.length);
  const cut = rest.indexOf("__");

  if (cut <= 0 || cut + 2 >= rest.length) {
    return undefined;
  }

  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
};

/** The connector behind a tool name, preferring the server's own name. */
const connectorOf = (
  name: string,
): { server: string; tool: string } | undefined => {
  const split = splitMcpName(name);
  // A tool not described yet borrows the name of a described sibling.
  const described =
    serverByTool.get(name) ??
    (split === undefined ? undefined : serverByPrefix.get(split.server));

  if (described !== undefined) {
    return { server: described, tool: split?.tool ?? name };
  }

  return split;
};

const rememberServer = (tool: string, server: string): void => {
  serverByTool.set(tool, server);
  const prefix = splitMcpName(tool)?.server;

  if (prefix !== undefined) {
    serverByPrefix.set(prefix, server);
  }
};

/**
 * Reads one tool_use block into what the ledger keeps of it; undefined for a
 * tool it does not list. Only the path or skill name is taken from the input.
 */
const classify = (name: string, input: unknown): PendingCall | undefined => {
  const fields = isRecord(input) ? input : {};
  const filePath =
    typeof fields.file_path === "string"
      ? fields.file_path
      : typeof fields.notebook_path === "string"
        ? fields.notebook_path
        : undefined;

  if (name === "Read" || name === "Write" || EDIT_TOOLS.includes(name)) {
    if (filePath === undefined || filePath === "") {
      return undefined;
    }

    const action: FileAction =
      name === "Read" ? "read" : name === "Write" ? "write" : "edit";

    return { kind: "file", action, path: filePath };
  }

  if (name === "Skill") {
    return typeof fields.skill === "string" && fields.skill !== ""
      ? { kind: "skill", skill: fields.skill, isPromptSeen: false }
      : undefined;
  }

  const connector = connectorOf(name);

  return connector === undefined
    ? undefined
    : { kind: "connector", server: connector.server, tool: connector.tool };
};

const rememberCall = (id: string, call: PendingCall): void => {
  pendingCalls.set(id, call);

  // A Map keeps insertion order, so the first key is the oldest call.
  while (pendingCalls.size > MAX_PENDING_CALLS) {
    const oldest = pendingCalls.keys().next().value;

    if (oldest === undefined) {
      break;
    }

    pendingCalls.delete(oldest);
  }
};

const bumpName = (list: readonly NameCount[], name: string): NameCount[] =>
  list.some((one) => one.name === name)
    ? list.map((one) =>
        one.name === name ? { ...one, count: one.count + 1 } : one,
      )
    : [...list, { name, count: 1 }];

const bumpConnector = (
  list: readonly ConnectorEntry[],
  server: string,
  tool: string,
  isError: boolean,
): ConnectorEntry[] => {
  const bumpTool = (entry: ConnectorEntry): ConnectorEntry => ({
    ...entry,
    calls: entry.calls + 1,
    failed: entry.failed + (isError ? 1 : 0),
    tools: entry.tools.some((one) => one.name === tool)
      ? entry.tools.map((one) =>
          one.name === tool ? { ...one, calls: one.calls + 1 } : one,
        )
      : [...entry.tools, { name: tool, calls: 1 }],
  });

  return list.some((one) => one.server === server)
    ? list.map((one) => (one.server === server ? bumpTool(one) : one))
    : [...list, bumpTool({ server, calls: 0, failed: 0, tools: [] })];
};

/**
 * Counts one finished file call. A Write to a path this ledger has not seen
 * yet counts as created, else as edited: no file system check is made.
 */
const bumpFile = (
  list: readonly FileEntry[],
  path: string,
  action: FileAction,
): FileEntry[] => {
  const existing = list.find((one) => one.path === path);

  if (existing === undefined) {
    return [
      ...list,
      {
        path,
        read: action === "read" ? 1 : 0,
        edited: action === "edit" ? 1 : 0,
        created: action === "write" ? 1 : 0,
      },
    ];
  }

  return list.map((one) =>
    one.path !== path
      ? one
      : action === "read"
        ? { ...one, read: one.read + 1 }
        : { ...one, edited: one.edited + 1 },
  );
};

/** Takes one back from a count, dropping a name that reaches zero. */
const dropName = (list: readonly NameCount[], name: string): NameCount[] =>
  list
    .map((one) => (one.name === name ? { ...one, count: one.count - 1 } : one))
    .filter((one) => one.count > 0);

/** Adds the files not listed yet; an instruction file's text is never kept. */
const mergeContextFiles = (
  list: readonly ContextFile[],
  incoming: readonly ContextFile[],
): ContextFile[] => {
  const merged = [...list];

  for (const file of incoming) {
    if (!merged.some((one) => one.path === file.path)) {
      merged.push({ path: file.path, kind: file.kind });
    }
  }

  return merged;
};

const resetAll = async ($: Engine): Promise<void> => {
  pendingCalls.clear();
  lastCommand = undefined;
  await update($, connectorsAtom, () => []);
  await update($, filesAtom, () => []);
  await update($, skillsAtom, () => []);
  await update($, commandsAtom, () => []);
  await update($, contextFilesAtom, () => []);
  await update($, expandedAtom, () => []);
};

const readLedger = async ($: Engine): Promise<Ledger> => ({
  connectors: await read($, connectorsAtom),
  files: await read($, filesAtom),
  skills: await read($, skillsAtom),
  commands: await read($, commandsAtom),
  contextFiles: await read($, contextFilesAtom),
});

/** `/Users/<name>` or `/home/<name>` when the project root lies inside it. */
const homeOf = (root: string): string | undefined =>
  /^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/.exec(root)?.[1];

/**
 * Paths under the project root are shown relative, others under the home
 * folder with `~`, the rest as they are.
 */
const pathViewFor = (root: string): PathView => {
  const home = root === "" ? undefined : homeOf(root);

  return (path) => {
    if (root !== "" && path.startsWith(`${root}/`)) {
      return path.slice(root.length + 1);
    }

    if (home !== undefined && path.startsWith(`${home}/`)) {
      return `~${path.slice(home.length)}`;
    }

    return path;
  };
};

const readPathView = async ($: Engine): Promise<PathView> => {
  try {
    return pathViewFor((await $.session.root()).replace(/[\\/]+$/, ""));
  } catch {
    return pathViewFor("");
  }
};

const fileHref = (path: string): string =>
  `file://${encodeURI(path.startsWith("/") ? path : `/${path}`)}`;

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const callsText = (count: number): string => plural(count, "call", "calls");

const fileActionsText = (file: FileEntry): string =>
  [
    file.read > 0 ? `read ${file.read}` : "",
    file.edited > 0 ? `edited ${file.edited}` : "",
    file.created > 0 ? `created ${file.created}` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");

const fileTotal = (file: FileEntry): number =>
  file.read + file.edited + file.created;

/** Most used first, then by name, without changing the list it is given. */
const byCountThenName = <T,>(
  list: readonly T[],
  count: (item: T) => number,
  name: (item: T) => string,
): T[] =>
  [...list].sort(
    (a, b) => count(b) - count(a) || name(a).localeCompare(name(b)),
  );

type UseRow = {
  name: string;
  label: string;
  kind: "skill" | "command";
  count: number;
};

/** Skills and commands in one list, as the pane and the export show them. */
const useRows = (ledger: Ledger): UseRow[] =>
  byCountThenName(
    [
      ...ledger.skills.map((one) => ({
        name: one.name,
        label: one.name,
        kind: "skill" as const,
        count: one.count,
      })),
      ...ledger.commands.map((one) => ({
        name: one.name,
        label: `/${one.name}`,
        kind: "command" as const,
        count: one.count,
      })),
    ],
    (row) => row.count,
    (row) => row.label,
  );

const sortedConnectors = (ledger: Ledger): ConnectorEntry[] =>
  byCountThenName(
    ledger.connectors,
    (one) => one.calls,
    (one) => one.server,
  );

const sortedTools = (entry: ConnectorEntry) =>
  byCountThenName(
    entry.tools,
    (one) => one.calls,
    (one) => one.name,
  );

const sortedFiles = (ledger: Ledger, view: PathView): FileEntry[] =>
  byCountThenName(ledger.files, fileTotal, (one) => view(one.path));

const connectorSummary = (entry: ConnectorEntry): string =>
  entry.failed > 0
    ? `${callsText(entry.calls)} · ${entry.failed} failed`
    : callsText(entry.calls);

/** The whole ledger as Markdown, with the same counts and paths as the pane. */
const ledgerMarkdown = (ledger: Ledger, view: PathView): string => {
  const lines: string[] = ["# Chat ledger"];
  const section = (title: string, rows: string[]): void => {
    lines.push("", `## ${title}`, "");
    lines.push(...(rows.length === 0 ? [EMPTY_TEXT] : rows));
  };
  const uses = useRows(ledger);

  section(
    `Connectors (${ledger.connectors.length})`,
    sortedConnectors(ledger).flatMap((entry) => [
      `- ${entry.server}: ${connectorSummary(entry)}`,
      ...sortedTools(entry).map(
        (tool) => `  - ${tool.name}: ${callsText(tool.calls)}`,
      ),
    ]),
  );
  section(
    `Files (${ledger.files.length})`,
    sortedFiles(ledger, view).map(
      (file) => `- ${view(file.path)}: ${fileActionsText(file)}`,
    ),
  );
  section(
    `Skills and commands (${uses.length})`,
    uses.map((row) => `- ${row.label} (${row.kind}): ${row.count}×`),
  );
  section(
    `Context files (${ledger.contextFiles.length})`,
    ledger.contextFiles.map((file) => `- ${view(file.path)} (${file.kind})`),
  );

  return `${lines.join("\n")}\n`;
};

const toggleConnector = async ($: Engine, server: string): Promise<void> => {
  await safely(() =>
    update($, expandedAtom, (list) =>
      list.includes(server)
        ? list.filter((one) => one !== server)
        : [...list, server],
    ),
  );
};

const copyLedger = async ($: Engine, surface: RenderSurface): Promise<void> => {
  let isCopied = false;

  try {
    const text = ledgerMarkdown(await readLedger($), await readPathView($));
    isCopied = (await $.ui.copy({ text, surface })).isCopied;
  } catch {
    isCopied = false;
  }

  await safely(async () =>
    $.ui.toast(isCopied ? "Ledger copied." : "Could not copy the ledger."),
  );
};

/** A finished call from its result block: counted, or dropped when errored. */
const countResult = async (
  $: Engine,
  call: PendingCall,
  isError: boolean,
): Promise<void> => {
  if (call.kind === "connector") {
    await update($, connectorsAtom, (list) =>
      bumpConnector(list, call.server, call.tool, isError),
    );

    return;
  }

  // A file call that failed or was denied touched nothing; the Skill was
  // counted when it was asked for.
  if (call.kind === "file" && !isError) {
    await update($, filesAtom, (list) =>
      bumpFile(list, call.path, call.action),
    );
  }
};

export const register: Register = (on) => {
  // Fires at the session's start and at every fresh load of the mod, so it
  // registers but never resets: the ledger outlives a reload.
  on("session.start", async ($, e, next) => {
    await safely(() =>
      $.command.register({
        name: "ledger",
        description:
          "Open the Ledger pane: connectors, files, skills, commands and context files used so far",
      }),
    );

    return next(e);
  }).catch(($, e, next) => next(e));

  // `/clear` and a resume change the conversation in this process.
  on("session.end", async ($, e, next) => {
    if (e.reason === "clear" || e.reason === "resume") {
      await safely(() => resetAll($));
    }

    return next(e);
  }).catch(($, e, next) => next(e));

  // Every command run, by name only: its arguments are never read. Counted
  // before it runs, so the `/clear` that resets the ledger is not carried into
  // the new one.
  on("command.run", async ($, e, next) => {
    const name = e.command;
    lastCommand = name;
    await safely(() => update($, commandsAtom, (list) => bumpName(list, name)));

    return next(e);
  }).catch(($, e, next) => next(e));

  on("command.run", { command: "ledger" }, async ($) => {
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE });

    // For the person alone: the mod never instructs the model.
    return { text: "Ledger opened.", isTextDisplayOnly: true };
  });

  // The server behind each MCP tool, as `/mcp` names it. Only the name is
  // kept; the description passes on untouched.
  on("tool.describe", async ($, e, next) => {
    const provider = e.provider.plugin;

    if (provider.startsWith(MCP_PROVIDER_PREFIX)) {
      rememberServer(e.tool, provider.slice(MCP_PROVIDER_PREFIX.length));
    }

    return next(e);
  }).catch(($, e, next) => next(e));

  // A skill loaded by `/name` or by the model. One the model asked for with
  // the Skill tool was counted at its request, so its prompt is not counted
  // again while that call is open.
  on("skill.prompt", async ($, e, next) => {
    const name = e.skill;
    let isCounted = false;

    for (const call of pendingCalls.values()) {
      if (call.kind === "skill" && call.skill === name && !call.isPromptSeen) {
        call.isPromptSeen = true;
        isCounted = true;
        break;
      }
    }

    // A `/name` run of this skill was counted as a command just before:
    // decided here in one synchronous step, then moved over to skills.
    const isFromCommand = !isCounted && lastCommand === name;

    if (isFromCommand) {
      lastCommand = undefined;
    }

    if (!isCounted) {
      await safely(() => update($, skillsAtom, (list) => bumpName(list, name)));
    }

    if (isFromCommand) {
      await safely(() =>
        update($, commandsAtom, (list) => dropName(list, name)),
      );
    }

    return next(e);
  }).catch(($, e, next) => next(e));

  // The instruction files behind the context, by path and kind; their text is
  // never read.
  on("prompt.context", async ($, e, next) => {
    const files = (e.instructionFiles ?? []).map((file) => ({
      path: file.path,
      kind: file.kind,
    }));

    if (files.length > 0) {
      await safely(() =>
        update($, contextFilesAtom, (list) => mergeContextFiles(list, files)),
      );
    }

    return next(e);
  }).catch(($, e, next) => next(e));

  // Every tool call of the main loop and of subagents: a response row asks for
  // it, a tool-result row answers it. No tool call is wrapped.
  on(
    "session.append",
    { door: ["response", "tool-result"] },
    async ($, e, next) => {
      const content: unknown = (e.message as { content?: unknown } | undefined)
        ?.content;
      const blocks = Array.isArray(content) ? content.filter(isRecord) : [];

      if (e.door === "response") {
        const skills: string[] = [];

        // Noted before the row is stored, in one synchronous step, so a
        // result landing meanwhile already finds its call.
        for (const block of blocks) {
          if (
            block.type !== "tool_use" ||
            typeof block.id !== "string" ||
            typeof block.name !== "string"
          ) {
            continue;
          }

          const call = classify(block.name, block.input);

          if (call === undefined) {
            continue;
          }

          rememberCall(block.id, call);

          if (call.kind === "skill") {
            skills.push(call.skill);
          }
        }

        const stored = await next(e);

        for (const skill of skills) {
          await safely(() =>
            update($, skillsAtom, (list) => bumpName(list, skill)),
          );
        }

        return stored;
      }

      const results = blocks.filter((block) => block.type === "tool_result");
      const finished: { call: PendingCall; isError: boolean }[] = [];
      const origin = e.origin;

      for (const block of results) {
        const id = block.tool_use_id;
        const isError = block.is_error === true;
        const known = typeof id === "string" ? pendingCalls.get(id) : undefined;

        if (typeof id === "string") {
          pendingCalls.delete(id);
        }

        // A call asked for before a reload is unknown here; a connector can
        // still be named from the row's origin when the row answers one call.
        const call =
          known ??
          (results.length === 1 &&
          origin.kind === "tool" &&
          origin.tool !== "unknown"
            ? classify(origin.tool, undefined)
            : undefined);

        if (call !== undefined) {
          finished.push({ call, isError });
        }
      }

      const stored = await next(e);

      for (const { call, isError } of finished) {
        await safely(() => countResult($, call, isError));
      }

      return stored;
    },
  ).catch(($, e, next) => next(e));

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e);
    const ledger = await readLedger($);
    const expanded = await read($, expandedAtom);
    const view = await readPathView($);
    const uses = useRows(ledger);

    // A file link is the terminal's (OSC 8): other surfaces take only https
    // links and would draw it as plain text with a warning, so they get text.
    const pathElement = (path: string) =>
      e.surface === "terminal" ? (
        <Link href={fileHref(path)} label={view(path)} />
      ) : (
        <Text wrap="truncate-end">{view(path)}</Text>
      );

    const section = (title: string, count: number, rows: RenderElement[]) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={HEADING} weight="bold">
          {`${title} (${count})`}
        </Text>
        {rows.length === 0 ? <Text dimColor>{EMPTY_TEXT}</Text> : rows}
      </Box>
    );

    const connectorRows = sortedConnectors(ledger).map((entry) => {
      const isOpen = expanded.includes(entry.server);
      const lead = `${isOpen ? "▾" : "▸"} ${entry.server}  ${callsText(entry.calls)}`;

      return (
        <Box key={`row:${entry.server}`} flexDirection="column">
          <Button
            key={`connector:${entry.server}`}
            onPress={() => void toggleConnector($, entry.server)}
          >
            {lead}
            {entry.failed > 0 ? (
              <Text color={DANGER}>{` · ${entry.failed} failed`}</Text>
            ) : (
              ""
            )}
          </Button>
          {isOpen
            ? sortedTools(entry).map((tool) => (
                <Text dimColor wrap="truncate-end">
                  {`    ${tool.name}  ${callsText(tool.calls)}`}
                </Text>
              ))
            : []}
        </Box>
      );
    });

    const fileRows = sortedFiles(ledger, view).map((file) => (
      <Box flexDirection="row">
        <Box flexShrink={1}>
          {pathElement(file.path)}
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{`  ${fileActionsText(file)}`}</Text>
        </Box>
      </Box>
    ));

    const useRowsDrawn = uses.map((row) => (
      <Box flexDirection="row">
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{row.label}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{`  ${row.kind} ×${row.count}`}</Text>
        </Box>
      </Box>
    ));

    const contextRows = ledger.contextFiles.map((file) => (
      <Box flexDirection="row">
        <Box flexShrink={1}>
          {pathElement(file.path)}
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{`  ${file.kind}`}</Text>
        </Box>
      </Box>
    ));

    return (
      <Box flexDirection="column">
        {section("Connectors", ledger.connectors.length, connectorRows)}
        {section("Files", ledger.files.length, fileRows)}
        {section("Skills and commands", uses.length, useRowsDrawn)}
        {section("Context files", ledger.contextFiles.length, contextRows)}
        <Box flexShrink={0}>
          <Button
            key="copy"
            label="Copy as Markdown"
            onPress={(press) => void copyLedger($, press.surface)}
          />
        </Box>
      </Box>
    );
  });
};
