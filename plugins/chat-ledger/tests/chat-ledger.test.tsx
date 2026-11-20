import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;
const ROOT = "/Users/dev/work/shop";

const LEDGER = {
  command: "ledger",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 120 },
} as const;

const PANE = {
  plugin: "chat-ledger",
  component: "Pane",
  requestId: "chat-ledger",
  props: {
    title: "Ledger",
    isFocused: false,
    bodyColumns: 80,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

type World = {
  opened: string[];
  copied: { text: string; surface: string | undefined }[];
  toasts: string[];
  // Every value the mod wrote to its state, as JSON.
  stateWrites: string[];
};

/**
 * Stands in for the engine beneath the mod: each hook answers as the engine
 * would and records what the mod asked for.
 */
const world = (on: On, { isCopied = true } = {}): World => {
  const result: World = { opened: [], copied: [], toasts: [], stateWrites: [] };

  on("command.register", () => ({ value: { command: "ledger" } }));
  on("session.root", () => ({ value: ROOT }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("command.run", () => ({ text: "ran" }));
  on("skill.prompt", (_, e) => ({ text: e.text }));
  on("prompt.context", (_, e) => ({ blocks: e.blocks }));
  on("tool.describe", (_, e) => ({ description: e.description }));
  on("ui.open", (_, e) => {
    result.opened.push(e.id);

    return { value: { isPlaced: true } };
  });
  on("ui.copy", (_, e) => {
    result.copied.push({ text: e.text, surface: e.surface });

    return {
      value: isCopied
        ? { isCopied: true as const }
        : { isCopied: false as const, reason: "no-clipboard" as const },
    };
  });
  on("ui.toast", (_, e) => {
    result.toasts.push(e.text);

    return { value: undefined };
  });
  on("state.set", async (_, e, next) => {
    result.stateWrites.push(JSON.stringify(e));

    return next(e);
  });

  return result;
};

let rowNumber = 0;

type Use = { name: string; input: Record<string, unknown> };

/** A response row asking for tool calls; returns their tool_use ids. */
const ask = async (
  $: Engine,
  uses: Use[],
  agentId?: string,
): Promise<string[]> => {
  const ids = uses.map(() => {
    rowNumber += 1;

    return `toolu_${rowNumber}`;
  });
  rowNumber += 1;
  await $.session.append({
    message: {
      type: "assistant",
      role: "assistant",
      content: uses.map((use, index) => ({
        type: "tool_use",
        id: ids[index],
        name: use.name,
        input: use.input,
      })),
    },
    door: "response",
    origin: { kind: "model", model: "claude" },
    uuid: `row-${rowNumber}`,
    ...(agentId === undefined ? {} : { agentId }),
  } as never);

  return ids;
};

/** The tool-result row answering one call. */
const answer = async (
  $: Engine,
  id: string,
  tool: string,
  { isError = false, agentId }: { isError?: boolean; agentId?: string } = {},
) => {
  rowNumber += 1;
  await $.session.append({
    message: {
      type: "user",
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: "secret result text",
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
    door: "tool-result",
    origin: { kind: "tool", tool },
    uuid: `row-${rowNumber}`,
    ...(agentId === undefined ? {} : { agentId }),
  } as never);
};

/** One tool call from request to result. */
const call = async (
  $: Engine,
  name: string,
  input: Record<string, unknown>,
  options: { isError?: boolean; agentId?: string } = {},
) => {
  const [id] = await ask($, [{ name, input }], options.agentId);
  await answer($, id ?? "", name, options);
};

const startAgent = ($: Engine, agentId: string) =>
  $.turn.start({ text: "go", turnId: `t-${agentId}`, agentId });

/** The Markdown the Copy button puts on the clipboard. */
const exported = async ($: Engine, engine: World): Promise<string> => {
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "copy" });
  await ui.unmount();

  return engine.copied.at(-1)?.text ?? "";
};

const texts = async (
  ui: {
    findAll: (query: {
      type?: string;
      text?: string | RegExp;
    }) => Promise<{ text: string }[]>;
  },
  type: string,
) => (await ui.findAll({ type })).map((one) => one.text);

test("MCP calls of main and subagents count per server and tool; errors count as failed", async ($, on) => {
  const engine = world(on);
  await $.tool.describe({
    tool: "mcp__claude_ai_Gmail__search_threads",
    description: "Search",
    provider: { plugin: "mcp:claude.ai Gmail", tier: "user" },
  });
  await startAgent($, "a1");

  await call($, "mcp__claude_ai_Gmail__search_threads", { query: "client" });
  await call($, "mcp__claude_ai_Gmail__search_threads", {}, { agentId: "a1" });
  // Not described yet: named after its described sibling.
  await call($, "mcp__claude_ai_Gmail__get_thread", {}, { isError: true });
  // Never described: the server comes from the name.
  await call($, "mcp__jira__get_issue", { key: "X-1" });

  expect(await exported($, engine)).toContain(
    [
      "## Connectors (2)",
      "",
      "- claude.ai Gmail: 3 calls · 1 failed",
      "  - search_threads: 2 calls",
      "  - get_thread: 1 call",
      "- jira: 1 call",
      "  - get_issue: 1 call",
    ].join("\n"),
  );
  // The query and the result text are never kept.
  expect(engine.stateWrites.join("\n")).not.toContain("client");
  expect(engine.stateWrites.join("\n")).not.toContain("secret result");
});

test("Read, Edit and Write count per path; errored calls do not count", async ($, on) => {
  const engine = world(on);
  await startAgent($, "a1");

  await call($, "Read", { file_path: `${ROOT}/src/app.ts` });
  await call($, "Read", { file_path: `${ROOT}/src/app.ts` }, { agentId: "a1" });
  await call($, "Edit", {
    file_path: `${ROOT}/src/app.ts`,
    old_string: "a",
    new_string: "b",
  });
  await call($, "Write", { file_path: `${ROOT}/src/new.ts`, content: "x" });
  // A Write to a path seen before is an edit.
  await call($, "Write", { file_path: `${ROOT}/src/new.ts`, content: "y" });
  await call($, "MultiEdit", { file_path: "/Users/dev/notes.md", edits: [] });
  await call($, "NotebookEdit", { notebook_path: "/opt/data/book.ipynb" });
  // Failed or denied: nothing was touched.
  await call(
    $,
    "Edit",
    { file_path: `${ROOT}/src/broken.ts` },
    { isError: true },
  );
  await call($, "Read", { file_path: `${ROOT}/src/app.ts` }, { isError: true });
  // Unknown tools and rows without usable blocks are ignored.
  await call($, "Bash", { command: "ls" });
  await call($, "Read", {});

  expect(await exported($, engine)).toContain(
    [
      "## Files (4)",
      "",
      "- src/app.ts: read 2 · edited 1",
      "- src/new.ts: edited 1 · created 1",
      "- /opt/data/book.ipynb: edited 1",
      "- ~/notes.md: edited 1",
    ].join("\n"),
  );
  expect(engine.stateWrites.join("\n")).not.toContain("broken");
  expect(engine.stateWrites.join("\n")).not.toContain("old_string");
});

test("skills and commands count; command arguments never reach state", async ($, on) => {
  const engine = world(on);

  // The model loads a skill: counted at the request, not again at its prompt.
  const [id] = await ask($, [
    { name: "Skill", input: { skill: "commit", args: "-m secret" } },
  ]);
  await $.skill.prompt({
    skill: "commit",
    text: "Commit the work",
    frontmatter: {},
    source: "userSettings",
  });
  await answer($, id ?? "", "Skill");
  // A skill run by `/name`: counted from its prompt.
  await $.skill.prompt({
    skill: "commit",
    text: "Commit the work",
    frontmatter: {},
    source: "userSettings",
  });
  await $.skill.prompt({
    skill: "review",
    text: "Review",
    frontmatter: {},
    source: "plugin",
  });
  await $.command.run({
    ...LEDGER,
    command: "compact",
    args: "keep the client secret",
  });
  await $.command.run({ ...LEDGER, command: "compact", args: "again" });

  const markdown = await exported($, engine);

  expect(markdown).toContain(
    [
      "## Skills and commands (3)",
      "",
      "- /compact (command): 2×",
      "- commit (skill): 2×",
      "- review (skill): 1×",
    ].join("\n"),
  );
  const written = engine.stateWrites.join("\n");
  expect(written).not.toContain("client secret");
  expect(written).not.toContain("again");
  expect(written).not.toContain("-m secret");
  expect(written).not.toContain("Commit the work");
});

test("prompt.context fills the context files, without their content", async ($, on) => {
  const engine = world(on);
  const files = [
    {
      path: `${ROOT}/CLAUDE.md`,
      kind: "project" as const,
      content: "Private rules A",
    },
    {
      path: "/Users/dev/.claude/CLAUDE.md",
      kind: "user" as const,
      content: "Private rules B",
    },
  ];
  await $.prompt.context({ blocks: [], instructionFiles: files });
  // A later conversation adds its own and repeats the first.
  await $.prompt.context({
    blocks: [],
    instructionFiles: [
      files[0]!,
      {
        path: `${ROOT}/.claude/rules/style.md`,
        kind: "project" as const,
        content: "C",
      },
    ],
  });
  // A rewritten context names no files: the list stays.
  await $.prompt.context({ blocks: [] });

  expect(await exported($, engine)).toContain(
    [
      "## Context files (3)",
      "",
      "- CLAUDE.md (project)",
      "- ~/.claude/CLAUDE.md (user)",
      "- .claude/rules/style.md (project)",
    ].join("\n"),
  );
  expect(engine.stateWrites.join("\n")).not.toContain("Private rules");
});

test("the pane draws four sections with counts and the empty state, on every surface", async ($, on) => {
  world(on);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const shown = await texts(ui, "Text");

    expect(shown.filter((one) => /\(\d+\)$/.test(one))).toEqual([
      "Connectors (0)",
      "Files (0)",
      "Skills and commands (0)",
      "Context files (0)",
    ]);
    expect(shown.filter((one) => one === "none yet")).toHaveLength(4);
    expect(
      (await ui.find({ type: "Text", text: "Connectors (0)" }))?.props.color,
    ).toBe("claude");
    expect(await ui.find({ type: "Button", key: "copy" })).toBeDefined();
    await ui.unmount();
  }

  await call($, "Read", { file_path: `${ROOT}/src/app.ts` });
  await call($, "Read", { file_path: `${ROOT}/src/app.ts` });
  await call($, "Read", { file_path: "/Users/dev/a.md" });
  await $.command.run({ ...LEDGER, command: "compact" });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const shown = await texts(ui, "Text");

    expect(shown).toContain("Files (2)");
    expect(shown).toContain("Skills and commands (1)");
    expect(shown.filter((one) => one === "none yet")).toHaveLength(2);

    // Most used first, shown relative; a file link on the terminal, plain
    // text where only https links are made.
    const links = await ui.findAll({ type: "Link" });

    if (surface === "terminal") {
      expect(links.map((one) => one.props.label)).toEqual([
        "src/app.ts",
        "~/a.md",
      ]);
      expect(links[0]?.props.href).toBe(`file://${ROOT}/src/app.ts`);
    } else {
      expect(links).toEqual([]);
      const paths = shown.filter(
        (one) => one === "src/app.ts" || one === "~/a.md",
      );
      expect(paths).toEqual(["src/app.ts", "~/a.md"]);
    }

    expect(shown).toContain("  read 2");
    expect(shown).toContain("/compact");
    expect(shown).toContain("  command ×1");
    await ui.unmount();
  }
});

test("a connector row expands to its tools and folds again, on every surface", async ($, on) => {
  world(on);
  await call($, "mcp__jira__get_issue", {});
  await call($, "mcp__jira__get_issue", {});
  await call($, "mcp__jira__search", {}, { isError: true });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const row = await ui.find({ type: "Button", key: "connector:jira" });

    expect(row?.text).toBe("▸ jira  3 calls · 1 failed");
    expect(
      (await ui.find({ type: "Text", text: " · 1 failed" }))?.props.color,
    ).toBe("error");
    expect(await ui.find({ type: "Text", text: /get_issue/ })).toBeUndefined();

    await ui.press({ key: "connector:jira" });
    expect(
      (await ui.find({ type: "Button", key: "connector:jira" }))?.text,
    ).toBe("▾ jira  3 calls · 1 failed");
    const tools = await ui.findAll({ type: "Text", text: /^ {4}/ });
    expect(tools.map((one) => one.text)).toEqual([
      "    get_issue  2 calls",
      "    search  1 call",
    ]);
    expect(tools[0]?.props.dimColor).toBe(true);

    await ui.press({ key: "connector:jira" });
    expect(await ui.find({ type: "Text", text: /get_issue/ })).toBeUndefined();
    await ui.unmount();
  }
});

test("Copy as Markdown gives the export format on the press surface", async ($, on) => {
  const engine = world(on);
  await call($, "mcp__jira__get_issue", {});
  await call($, "Read", { file_path: `${ROOT}/README.md` });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: "copy" });
    await ui.unmount();
    expect(engine.copied.at(-1)?.surface).toBe(surface);
  }

  expect(engine.copied[0]?.text).toBe(
    [
      "# Chat ledger",
      "",
      "## Connectors (1)",
      "",
      "- jira: 1 call",
      "  - get_issue: 1 call",
      "",
      "## Files (1)",
      "",
      "- README.md: read 1",
      "",
      "## Skills and commands (0)",
      "",
      "none yet",
      "",
      "## Context files (0)",
      "",
      "none yet",
      "",
    ].join("\n"),
  );
  expect(engine.toasts).toEqual(["Ledger copied.", "Ledger copied."]);
});

test("a refused copy says so", async ($, on) => {
  const engine = world(on, { isCopied: false });
  await exported($, engine);

  expect(engine.toasts).toEqual(["Could not copy the ledger."]);
});

test("/ledger opens the pane and says so", async ($, on) => {
  const engine = world(on);
  await $.session.start({
    cwd: ROOT,
    surface: "terminal",
    isInteractive: true,
  });

  const reply = await $.command.run(LEDGER);

  expect(reply.text).toBe("Ledger opened.");
  expect(engine.opened).toEqual(["chat-ledger"]);
});

test("/clear and resume reset the ledger; a reload does not", async ($, on) => {
  const engine = world(on);
  await call($, "Read", { file_path: `${ROOT}/a.ts` });
  await call($, "mcp__jira__get_issue", {});

  // `session.start` fires again at every reload of the mod.
  await $.session.start({
    cwd: ROOT,
    surface: "terminal",
    isInteractive: true,
  });
  expect(await exported($, engine)).toContain("- a.ts: read 1");

  await $.session.end({
    reason: "clear",
    sessionId: "s1",
    resume: {} as never,
  });
  const cleared = await exported($, engine);
  expect(cleared).toContain("## Files (0)");
  expect(cleared).toContain("## Connectors (0)");

  await call($, "Read", { file_path: `${ROOT}/b.ts` });
  await $.session.end({
    reason: "resume",
    sessionId: "s1",
    resume: {} as never,
  });
  expect(await exported($, engine)).toContain("## Files (0)");

  // A call asked for before the clear is not counted after it.
  const [id] = await ask($, [
    { name: "Read", input: { file_path: `${ROOT}/c.ts` } },
  ]);
  await $.session.end({
    reason: "clear",
    sessionId: "s1",
    resume: {} as never,
  });
  await answer($, id ?? "", "Read");
  expect(await exported($, engine)).toContain("## Files (0)");

  // Other endings keep it.
  await call($, "Read", { file_path: `${ROOT}/d.ts` });
  await $.session.end({
    reason: "other",
    sessionId: "s1",
    resume: {} as never,
  });
  expect(await exported($, engine)).toContain("- d.ts: read 1");
});

test("hooks hand every event on unchanged and never deny", async ($, on) => {
  const received: unknown[] = [];
  const stored: unknown[] = [];
  on("session.append", async (_, e, next) => {
    received.push(e.message.content);
    const row = await next(e);
    stored.push(row);

    return row;
  });
  world(on);
  await startAgent($, "a1");

  const useBlock = {
    type: "tool_use",
    id: "toolu_p1",
    name: "Read",
    input: { file_path: `${ROOT}/a.ts` },
  };
  const resultBlock = {
    type: "tool_result",
    tool_use_id: "toolu_p1",
    content: "ok",
    is_error: true,
  };
  const response = await $.session.append({
    message: { type: "assistant", role: "assistant", content: [useBlock] },
    door: "response",
    origin: { kind: "model", model: "claude" },
    uuid: "row-p1",
  } as never);
  const result = await $.session.append({
    message: { type: "user", role: "user", content: [resultBlock] },
    door: "tool-result",
    origin: { kind: "tool", tool: "Read" },
    uuid: "row-p2",
    agentId: "a1",
  } as never);
  // A row with no blocks to read passes too.
  const bare = await $.session.append({
    message: { type: "user", role: "user", content: [] },
    door: "tool-result",
    origin: { kind: "tool", tool: "unknown" },
    uuid: "row-p3",
  } as never);

  expect(response).toEqual(stored[0]);
  expect(result).toEqual(stored[1]);
  expect(bare).toEqual(stored[2]);
  expect(received).toEqual([[useBlock], [resultBlock], []]);

  expect(
    await $.command.run({ ...LEDGER, command: "compact", args: "x" }),
  ).toEqual({ text: "ran" });
  expect(
    await $.skill.prompt({
      skill: "commit",
      text: "Commit it",
      frontmatter: {},
      source: "userSettings",
    }),
  ).toEqual({ text: "Commit it" });
  const blocks = [{ name: "claudeMd", text: "rules" }];
  const instructionFiles = [
    { path: `${ROOT}/CLAUDE.md`, kind: "project" as const, content: "rules" },
  ];
  // The engine keeps the files behind the blocks it was handed; the mod
  // changes neither.
  expect(await $.prompt.context({ blocks, instructionFiles })).toMatchObject({
    blocks,
    instructionFiles,
  });
  expect(
    await $.tool.describe({
      tool: "mcp__jira__get_issue",
      description: "Get an issue",
      provider: { plugin: "mcp:jira", tier: "user" },
    }),
  ).toEqual({ description: "Get an issue" });
  expect(
    await $.session.start({
      cwd: ROOT,
      surface: "terminal",
      isInteractive: true,
    }),
  ).toEqual({ cwd: ROOT });
  expect(
    await $.session.end({
      reason: "clear",
      sessionId: "s1",
      resume: {} as never,
    }),
  ).toEqual({ sessionId: "s1" });
});
