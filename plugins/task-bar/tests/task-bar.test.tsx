import { expect, mock, test } from "claude-code/testing";
import type { Engine, Plugin } from "claude-code/testing";
import type { AgentInfo, On, RenderElement, ToolCallResult } from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;
const CREW = {
  command: "crew",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: true, columns: 200 },
} as const;
const START = 1_000_000;

const BAND = {
  plugin: "task-bar",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

const PANE = {
  plugin: "task-bar",
  component: "Pane",
  requestId: "task-bar-crew",
  props: {
    title: "Crew",
    isFocused: false,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const;

type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

const todo = (content: string, status: Todo["status"]): Todo => ({
  content,
  status,
  activeForm: `Doing ${content}`,
});

const FIVE: Todo[] = [
  todo("Read the code", "completed"),
  todo("Write the fix", "completed"),
  todo("Write a test", "completed"),
  { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
  todo("Open a PR", "pending"),
];

const agentInfo = (
  id: string,
  type: string,
  description: string,
): AgentInfo => ({
  id,
  type,
  description,
  status: "running",
  kind: "local_agent",
  taskStatus: "running",
  label: description,
  startTime: START,
  cwd: "/",
  tokenCount: 0,
  tokenSamples: [],
  hasRow: true,
});

type World = {
  opened: string[];
  // The tools the mod registered, as it asked for them.
  registered: { name: string; description: string; inputSchema?: unknown }[];
  // What the next call of a tool answers instead of a success, once.
  failNext: Map<string, ToolCallResult>;
  advance: (ms: number) => Promise<void>;
};

/**
 * Stands in for the engine beneath the mod: each hook here answers as the
 * engine would, and the answers are what the mod must hand back unchanged.
 */
const world = (
  on: On,
  agents: AgentInfo[] = [],
  {
    hasBuiltinTodos = true,
    registeredAs = (name: string) => `mcp__task-bar__${name}`,
  } = {},
): World => {
  const clock = mock.clock(on, { now: START });
  const opened: string[] = [];
  const registered: World["registered"] = [];
  const tool = (name: string) => ({
    name,
    description: name,
    mcp: false,
    decision: "allow" as const,
  });
  const failNext = new Map<string, ToolCallResult>();
  let nextTaskId = 0;

  on("command.register", () => ({ value: { command: "crew" } }));
  on("tool.list", () => ({
    value: hasBuiltinTodos
      ? [tool("Bash"), tool("TodoWrite"), tool("TaskCreate"), tool("TaskUpdate")]
      : [tool("Bash"), tool("Read")],
  }));
  on("tool.register", (_, e) => {
    registered.push(e);

    return { value: { tool: registeredAs(e.name) } };
  });
  on("ui.open", (_, e) => {
    opened.push(e.id);

    return { value: { isPlaced: true } };
  });
  on("agent.list", () => ({ value: agents }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("prompt.submit", (_, e) => ({ text: e.text }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  // No settings hook beneath: the classic events answer nothing of their own.
  on("classic.PostToolUse", () => ({}));
  on("classic.PostToolUseFailure", () => ({}));
  on("tool.call", (_, e) => {
    const failure = failNext.get(String(e.tool));

    if (failure !== undefined) {
      failNext.delete(String(e.tool));

      return failure;
    }

    if (e.tool === "TodoWrite") {
      return { result: { oldTodos: [], newTodos: e.todos } };
    }

    if (e.tool === "TaskCreate") {
      nextTaskId += 1;

      return {
        result: { task: { id: String(nextTaskId), subject: e.subject } },
      };
    }

    if (e.tool === "TaskUpdate") {
      return {
        result: { success: true, taskId: e.taskId, updatedFields: ["status"] },
      };
    }

    return { result: { ok: true } };
  });

  return {
    opened,
    registered,
    failNext,
    advance: (ms) => clock.advance(ms),
  };
};

/**
 * A tool call that ran, as the engine reports it after the fact: the classic
 * PostToolUse (or PostToolUseFailure) event, which the mod observes for the
 * subagent cards and the reminders. Returns the context the answer carries.
 */
const finished = async (
  $: Engine,
  tool: string,
  agentId?: string,
  { hasFailed = false } = {},
): Promise<readonly string[] | undefined> => {
  const loop = agentId === undefined ? {} : { agent_id: agentId };
  const toolUseId = await responseRow($, tool, agentId);
  const answer = hasFailed
    ? await $.classic.PostToolUseFailure({
        tool_name: tool,
        tool_input: {},
        tool_use_id: toolUseId,
        error: "failed",
        ...loop,
      })
    : await $.classic.PostToolUse({
        tool_name: tool,
        tool_input: {},
        tool_response: {},
        tool_use_id: toolUseId,
        ...loop,
      });

  // A subagent's call also leaves a tool-result row in its own conversation,
  // which is where the mod counts it.
  if (agentId !== undefined) {
    await toolResultRow($, tool, agentId);
  }

  return answer.additionalContext;
};

let rowNumber = 0;

/**
 * The response row that asks for a tool call, kept in the conversation of the
 * loop that makes it before the tool runs. Returns the call's tool_use id.
 */
const responseRow = async ($: Engine, tool: string, agentId?: string): Promise<string> => {
  rowNumber += 1;
  const id = `toolu_${rowNumber}`;
  await $.session.append({
    message: {
      type: "assistant",
      role: "assistant",
      content: [{ type: "tool_use", id, name: tool, input: {} }],
    },
    door: "response",
    origin: { kind: "model", model: "claude" },
    uuid: `row-${rowNumber}`,
    ...(agentId === undefined ? {} : { agentId }),
  } as never);

  return id;
};

/** The tool-result row a subagent's conversation keeps after a call. */
const toolResultRow = async ($: Engine, tool: string, agentId: string) => {
  rowNumber += 1;
  await $.session.append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `toolu_${rowNumber}`, content: "ok" }],
    },
    door: "tool-result",
    origin: { kind: "tool", tool },
    uuid: `row-${rowNumber}`,
    agentId,
  } as never);
};

/** The shown text of the first Text matching the pattern. */
const cardText = async (
  ui: { find: (query: { type?: string; text?: string | RegExp }) => Promise<{ text: string } | undefined> },
  pattern: RegExp,
) => (await ui.find({ type: "Text", text: pattern }))?.text;

test("a TodoWrite list of 5 with 3 done draws 3/5 and what runs now, on every surface", async ($, on) => {
  world(on);
  await $.tool.call({ tool: "TodoWrite", todos: FIVE });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });

    const row = await ui.find({ type: "Text", text: /3\/5/ });
    expect(row?.text).toBe("▏ 3/5  Running tests");
    // The bar takes the rest of the 80 columns: 80 - 1 - 20 = 59 cells, of
    // which 3 of 5 is 35, in the theme's accent.
    const filled = await ui.find({ type: "Text", text: "█" });
    expect(filled?.text).toBe("█".repeat(35));
    expect(filled?.props.color).toBe("claude");
    expect((await ui.find({ type: "Text", text: "░" }))?.text).toBe(
      "░".repeat(24),
    );
    await ui.unmount();
  }
});

test("the text clips with an ellipsis to fit the band", async ($, on) => {
  world(on);
  const long = "x".repeat(200);
  await $.tool.call({
    tool: "TodoWrite",
    todos: [{ content: "Long", status: "in_progress", activeForm: long }],
  });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    const row = await ui.find({ type: "Text", text: /0\/1/ });

    expect(row?.text.endsWith("…")).toBe(true);
    // The text is clipped first, so the bar keeps its 10 cells:
    // 80 - 1 edge - 10 cells - "▏ 0/1" - 2 spaces leave 62 for the text.
    expect(row?.text.length).toBe("▏ 0/1  ".length + 62);
    expect((await ui.find({ type: "Text", text: "░" }))?.text).toBe("░".repeat(10));
    await ui.unmount();
  }
});

test("TaskCreate x3 then one completed draws 1/3; deleted drops a task", async ($, on) => {
  world(on);
  await $.tool.call({
    tool: "TaskCreate",
    subject: "One",
    description: "d",
    activeForm: "Doing one",
  });
  await $.tool.call({ tool: "TaskCreate", subject: "Two", description: "d" });
  await $.tool.call({ tool: "TaskCreate", subject: "Three", description: "d" });
  await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: "Text", text: /\/3/ }))?.text).toBe(
      "▏ 1/3  Two",
    );
    await ui.unmount();
  }

  await $.tool.call({
    tool: "TaskUpdate",
    taskId: "2",
    status: "in_progress",
    activeForm: "Doing two",
  });
  await $.tool.call({ tool: "TaskUpdate", taskId: "3", status: "deleted" });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: "Text", text: /\/2/ }))?.text).toBe(
      "▏ 1/2  Doing two",
    );
    await ui.unmount();
  }
});

test("a subagent TaskCreate writes the main list, not its card", async ($, on) => {
  world(on, [agentInfo("a1", "Explore", "Map the hooks folder")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.tool.call({
    tool: "TaskCreate",
    subject: "Shared",
    description: "d",
    agentId: "a1",
  });

  const band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await band.find({ type: "Text", text: /0\/1/ }))?.text).toBe(
    "▏ 0/1  Shared",
  );
  await band.unmount();
});

const ALL_DONE = FIVE.map((one) => ({ ...one, status: "completed" as const }));

test("all completed draws the done row in success, still there much later", async ($, on) => {
  const engine = world(on);
  await $.tool.call({ tool: "TodoWrite", todos: FIVE });
  await $.tool.call({ tool: "TodoWrite", todos: ALL_DONE });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: "Text", text: /done/ }))?.text).toBe(
      "▏ All 5 done",
    );
    const bar = await ui.find({ type: "Text", text: "█" });
    // Full width: 80 - 1 - "▏ All 5 done".length = 67 cells.
    expect(bar?.text).toBe("█".repeat(67));
    expect(bar?.props.color).toBe("success");
    await ui.unmount();
  }

  // No timer hides it: an hour later it is still drawn.
  await engine.advance(3_600_000);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: "Text", text: /done/ }))?.text).toBe(
      "▏ All 5 done",
    );
    await ui.unmount();
  }
});

test("the done row is gone after the next prompt", async ($, on) => {
  world(on);
  await $.tool.call({ tool: "TodoWrite", todos: ALL_DONE });
  await $.prompt.submit({ text: "next", wait: false, origin: { kind: "composer" } });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: "Text", text: /done|█|░/ })).toBeUndefined();
    expect(await ui.keepsBeneath()).toBe(true);
    await ui.unmount();
  }
});

test("an unfinished list survives the next prompt", async ($, on) => {
  world(on);
  await $.tool.call({ tool: "TodoWrite", todos: FIVE });
  await $.prompt.submit({ text: "next", wait: false, origin: { kind: "composer" } });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: "Text", text: /3\/5/ }))?.text).toBe(
      "▏ 3/5  Running tests",
    );
    await ui.unmount();
  }
});

test("a reopened task clears the done state", async ($, on) => {
  world(on);
  await $.tool.call({ tool: "TodoWrite", todos: [todo("Only", "completed")] });
  await $.tool.call({
    tool: "TodoWrite",
    todos: [todo("Only", "in_progress")],
  });

  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /0\/1/ }))?.text).toBe(
    "▏ 0/1  Doing Only",
  );
  await ui.unmount();
});

test("an empty list or a survey leaves the band to the engine", async ($, on) => {
  world(on);

  for (const surface of SURFACES) {
    const empty = await $.ui.mount({ ...BAND, surface });
    expect(await empty.keepsBeneath()).toBe(true);
    expect(await empty.find({ type: "Text", text: /█|░/ })).toBeUndefined();
    await empty.unmount();
  }

  await $.tool.call({ tool: "TodoWrite", todos: FIVE });

  for (const surface of SURFACES) {
    const survey = await $.ui.mount({
      ...BAND,
      surface,
      props: { ...BAND.props, hasSurvey: true },
    });
    expect(await survey.keepsBeneath()).toBe(true);
    expect(await survey.find({ type: "Text", text: /3\/5/ })).toBeUndefined();
    await survey.unmount();
  }
});

test("an errored TodoWrite or TaskUpdate leaves the state unchanged", async ($, on) => {
  const engine = world(on);
  await $.tool.call({ tool: "TaskCreate", subject: "One", description: "d" });
  await $.tool.call({ tool: "TaskCreate", subject: "Two", description: "d" });

  engine.failNext.set("TaskUpdate", {
    isError: true,
    result: "no such task",
    text: "no such task",
  });
  await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" });
  engine.failNext.set("TaskUpdate", {
    result: {
      success: false,
      taskId: "1",
      updatedFields: [],
      error: "refused",
    },
  });
  await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "deleted" });
  engine.failNext.set("TodoWrite", {
    isError: true,
    result: undefined,
    text: "invalid",
  });
  await $.tool.call({ tool: "TodoWrite", todos: [todo("Other", "completed")] });
  // A result in a shape the mod does not know is skipped the same way.
  engine.failNext.set("TodoWrite", { result: { newTodos: "not a list" } });
  await $.tool.call({
    tool: "TodoWrite",
    todos: [{ content: "x", status: "nope", activeForm: "x" }],
  } as never);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: "Text", text: /\/2/ }))?.text).toBe(
      "▏ 0/2  One",
    );
    await ui.unmount();
  }
});

test("a subagent start, its tool calls and its end give one card", async ($, on) => {
  const engine = world(on, [
    agentInfo("a1", "Explore", "Map the hooks folder"),
  ]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await finished($, "Read", "a1");
  await finished($, "Bash", "a1");
  await finished($, "Grep", "a1");

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await cardText(ui, /^Explore$/)).toBe("Explore");
    expect(await cardText(ui, /hooks folder/)).toBe("  Map the hooks folder");
    expect(await cardText(ui, /running/)).toBe(" running 0s");
    expect((await ui.find({ type: "Text", text: /●/ }))?.props.color).toBe(
      "claude",
    );
    expect(await cardText(ui, /tool calls/)).toBe("  3 tool calls · last: Grep");
    await ui.unmount();
  }

  // The elapsed time ticks while the card runs.
  const live = await $.ui.mount({ ...PANE, surface: "terminal" });
  await engine.advance(72_000);
  expect(await cardText(live, /running/)).toBe(" running 1m 12s");
  await live.unmount();

  await $.turn.complete({
    answer: "report",
    durationMs: 72_000,
    isAborted: false,
    turnId: "t1",
    agentId: "a1",
    reason: "answer",
  });
  await engine.advance(10_000);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await ui.findAll({ type: "Text", text: /^Explore$/ })).toHaveLength(1);
    expect((await ui.find({ type: "Text", text: /●/ }))?.props.color).toBe(
      "success",
    );
    // Stopped at the end: the clock moved on, the time did not.
    expect(await cardText(ui, /done/)).toBe(" done 1m 12s");
    expect(await cardText(ui, /tool calls/)).toBe("  3 tool calls · last: Grep");
    await ui.unmount();
  }
});

test("a failed subagent gets the danger dot; cards list newest first", async ($, on) => {
  const engine = world(on, [
    agentInfo("a1", "Explore", "First"),
    agentInfo("a2", "Plan", "Second"),
  ]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await engine.advance(1000);
  await $.turn.start({ text: "go", turnId: "t2", agentId: "a2" });
  await $.turn.complete({
    answer: "",
    durationMs: 5,
    isAborted: false,
    turnId: "t1",
    agentId: "a1",
    reason: "error",
  });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const titles = await ui.findAll({
      type: "Text",
      text: /^ {2}(First|Second)$/,
    });
    expect(titles.map((one) => one.text)).toEqual(["  Second", "  First"]);
    const dots = await ui.findAll({ type: "Text", text: /●/ });
    expect(dots.map((one) => one.props.color)).toEqual(["claude", "error"]);
    await ui.unmount();
  }
});

test("an id no agent list names gets no card", async ($, on) => {
  world(on);
  await $.turn.start({ text: "", turnId: "t1", agentId: "fork-1" });
  await $.tool.call({ tool: "Bash", command: "ls", agentId: "fork-1" });

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect((await ui.find({ type: "Text" }))?.text).toBe(
    "No subagents in this chat yet.",
  );
  await ui.unmount();
});

test("a subagent TodoWrite fills its card bar, not the main bar", async ($, on) => {
  world(on, [agentInfo("a1", "Explore", "Map the hooks folder")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.tool.call({
    tool: "TodoWrite",
    todos: [
      todo("A", "completed"),
      todo("B", "completed"),
      todo("C", "in_progress"),
      todo("D", "pending"),
    ],
    agentId: "a1",
  });

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface });
    expect(await band.keepsBeneath()).toBe(true);
    expect(await band.find({ type: "Text", text: /█|░/ })).toBeUndefined();
    await band.unmount();

    const pane = await $.ui.mount({ ...PANE, surface });
    expect((await pane.find({ type: "Text", text: /2\/4/ }))?.text).toBe(
      "▏ 2/4",
    );
    expect((await pane.find({ type: "Text", text: "█" }))?.text).toBe(
      "█".repeat(6),
    );
    expect((await pane.find({ type: "Text", text: "░" }))?.text).toBe(
      "░".repeat(6),
    );
    await pane.unmount();
  }
});

test("/crew opens the pane and says so", async ($, on) => {
  const engine = world(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  const reply = await $.command.run(CREW);

  expect(reply.text).toBe("Crew pane opened.");
  expect(engine.opened).toEqual(["task-bar-crew"]);
});

test("the pane opens by itself once, at the first subagent", async ($, on) => {
  const engine = world(on, [
    agentInfo("a1", "Explore", "One"),
    agentInfo("a2", "Explore", "Two"),
  ]);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.turn.start({ text: "go", turnId: "t2", agentId: "a2" });

  expect(engine.opened).toEqual(["task-bar-crew"]);
});

// The test kit has no way to raise a person's close (the close mark): its `$`
// has no `ui.close`, and a test's own hooks may not call `$.ui.close`. So an
// inline plugin closes the pane, which the mod hears with origin `plugin`.
const CLOSER = {
  name: "pane-closer",
  register(on) {
    on("session.start", async ($, e, next) => {
      const started = await next(e);
      await $.ui.close({ id: "task-bar-crew" });

      return started;
    });
  },
} satisfies Plugin;

test(
  "a plugin closing the pane does not stop auto-open",
  { plugins: [CLOSER] },
  async ($, on) => {
    const engine = world(on, [agentInfo("a1", "Explore", "One")]);
    on("ui.close", () => ({ value: undefined }));
    await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
    await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });

    expect(engine.opened).toEqual(["task-bar-crew"]);
  },
);

test("a pane the person closed is not opened by itself again", async ($, on) => {
  // What the mod's ui.close hook stores on a person's close, read back.
  on("state.get", { key: "paneClosedByUser" }, () => ({
    value: { value: true, version: 1 },
  }));
  const engine = world(on, [agentInfo("a1", "Explore", "One")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });

  expect(engine.opened).toEqual([]);

  // The person can still open it by hand.
  await $.command.run(CREW);
  expect(engine.opened).toEqual(["task-bar-crew"]);
});

test("the next prompt drops finished cards; /clear resets everything", async ($, on) => {
  world(on, [
    agentInfo("a1", "Explore", "Done one"),
    agentInfo("a2", "Explore", "Still going"),
  ]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.turn.start({ text: "go", turnId: "t2", agentId: "a2" });
  await $.turn.complete({
    answer: "",
    durationMs: 5,
    isAborted: false,
    turnId: "t1",
    agentId: "a1",
    reason: "answer",
  });
  await $.prompt.submit({
    text: "next",
    wait: false,
    origin: { kind: "composer" },
  });

  const after = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(
    (await after.findAll({ type: "Text", text: /^ {2}(Done one|Still going)$/ })).map(
      (one) => one.text,
    ),
  ).toEqual(["  Still going"]);
  await after.unmount();

  await $.tool.call({ tool: "TodoWrite", todos: FIVE });
  await $.session.end({
    reason: "clear",
    sessionId: "s1",
    resume: {} as never,
  });

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await pane.find({ type: "Text" }))?.text).toBe(
    "No subagents in this chat yet.",
  );
  await pane.unmount();
  const band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await band.keepsBeneath()).toBe(true);
  await band.unmount();
});

test("hooks hand every result on unchanged and never deny", async ($, on) => {
  // What lies below the mod for a kept row: recorded as the kit stored it.
  const stored: unknown[] = [];
  const received: unknown[] = [];
  on("session.append", async (_, e, next) => {
    received.push(e.message.content);
    const row = await next(e);
    stored.push(row);

    return row;
  });
  world(on, [agentInfo("a1", "Explore", "One")]);
  await $.turn.start({ text: "go", turnId: "t0", agentId: "a1" });

  // A main-loop response row and a subagent's tool-result row come back
  // exactly as stored beneath the mod.
  const response = await $.session.append({
    message: {
      type: "assistant",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_r1", name: "Bash", input: {} }],
    },
    door: "response",
    origin: { kind: "model", model: "claude" },
    uuid: "row-r1",
  } as never);
  const result = await $.session.append({
    message: {
      type: "user",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_r2", content: "ok" }],
    },
    door: "tool-result",
    origin: { kind: "tool", tool: "Bash" },
    uuid: "row-r2",
    agentId: "a1",
  } as never);
  expect(response).toEqual(stored[0]);
  expect(result).toEqual(stored[1]);
  // And the rows reached the store as sent: the mod rewrote nothing.
  expect(received).toEqual([
    [{ type: "tool_use", id: "toolu_r1", name: "Bash", input: {} }],
    [{ type: "tool_result", tool_use_id: "toolu_r2", content: "ok" }],
  ]);

  // Each answer below is exactly what the engine's hook beneath gave.
  expect(await $.tool.call({ tool: "TodoWrite", todos: FIVE })).toEqual({
    result: { oldTodos: [], newTodos: FIVE },
  });
  expect(
    await $.tool.call({ tool: "TaskCreate", subject: "One", description: "d" }),
  ).toEqual({
    result: { task: { id: "1", subject: "One" } },
  });
  expect(
    await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" }),
  ).toEqual({
    result: { success: true, taskId: "1", updatedFields: ["status"] },
  });
  expect(
    await $.tool.call({ tool: "Bash", command: "ls", agentId: "a1" }),
  ).toEqual({
    result: { ok: true },
  });
  expect(
    await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" }),
  ).toEqual({ turnId: "t1" });
  expect(
    await $.turn.complete({
      answer: "report",
      durationMs: 1,
      isAborted: true,
      turnId: "t1",
      agentId: "a1",
      reason: "aborted",
    }),
  ).toMatchObject({ text: "report" });
  expect(
    await $.prompt.submit({
      text: "hi",
      wait: false,
      origin: { kind: "composer" },
    }),
  ).toMatchObject({
    text: "hi",
  });
  expect(
    await $.session.end({
      reason: "clear",
      sessionId: "s1",
      resume: {} as never,
    }),
  ).toEqual({
    sessionId: "s1",
  });
});

test("a failing $ call inside a hook still passes the event on", async ($, on) => {
  // No agent.list and no clock beneath: those calls throw inside the mod.
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("tool.call", () => ({ result: { ok: true } }));

  expect(
    await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" }),
  ).toEqual({ turnId: "t1" });
  expect(
    await $.tool.call({
      tool: "TodoWrite",
      todos: [todo("Only", "completed")],
    }),
  ).toEqual({
    result: { ok: true },
  });
});

test("parallel TaskCreate and TaskUpdate never draw the done row while a task is open", async ($, on) => {
  world(on);
  await $.tool.call({ tool: "TaskCreate", subject: "One", description: "d" });
  await $.tool.call({ tool: "TaskCreate", subject: "Two", description: "d" });
  await $.tool.call({ tool: "TaskUpdate", taskId: "1", status: "completed" });

  // The last open task completes while a new one is created.
  await Promise.all([
    $.tool.call({ tool: "TaskUpdate", taskId: "2", status: "completed" }),
    $.tool.call({ tool: "TaskCreate", subject: "Three", description: "d" }),
  ]);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect(await ui.find({ type: "Text", text: /All/ })).toBeUndefined();
    expect((await ui.find({ type: "Text", text: /\/3/ }))?.text).toBe("▏ 2/3  Three");
    await ui.unmount();
  }

  await $.tool.call({ tool: "TaskUpdate", taskId: "3", status: "completed" });
  const done = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await done.find({ type: "Text", text: /done/ }))?.text).toBe("▏ All 3 done");
  await done.unmount();
});

test("a TodoWrite answering an empty list once all is done keeps the done state", async ($, on) => {
  const engine = world(on);
  engine.failNext.set("TodoWrite", { result: { oldTodos: FIVE, newTodos: [] } });
  await $.tool.call({ tool: "TodoWrite", todos: ALL_DONE });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: "Text", text: /done/ }))?.text).toBe("▏ All 5 done");
    await ui.unmount();
  }
});

test("an errored subagent call counts on its card", async ($, on) => {
  world(on, [agentInfo("a1", "Explore", "One")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await finished($, "Read", "a1");
  await finished($, "Glob", "a1", { hasFailed: true });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await cardText(ui, /tool calls/)).toBe("  2 tool calls · last: Glob");
    await ui.unmount();
  }
});

test("the elapsed ticker runs only while a card runs", async ($, on) => {
  let redraws = 0;
  on("ui.invalidate", () => {
    redraws += 1;

    return { value: undefined };
  });
  const engine = world(on, [agentInfo("a1", "Explore", "One")]);
  // The pane opens by itself here, so the ticker starts with the card.
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await engine.advance(3000);
  expect(redraws).toBe(3);

  await $.turn.complete({
    answer: "",
    durationMs: 3000,
    isAborted: false,
    turnId: "t1",
    agentId: "a1",
    reason: "answer",
  });
  await engine.advance(10_000);
  expect(redraws).toBe(3);
});


test("a background task's notification keeps finished cards and the done list", async ($, on) => {
  world(on, [agentInfo("a1", "Explore", "Background one")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.turn.complete({
    answer: "",
    durationMs: 5,
    isAborted: false,
    turnId: "t1",
    agentId: "a1",
    reason: "answer",
  });
  await $.tool.call({ tool: "TodoWrite", todos: ALL_DONE });

  // The agent's completion enters as a prompt of its own, not the person's.
  await $.prompt.submit({
    text: "<task-notification>",
    wait: false,
    isMeta: true,
    origin: { kind: "task-notification" },
  });
  await $.prompt.submit({
    text: "plugin says hi",
    wait: false,
    origin: { kind: "plugin", name: "other" },
  } as never);

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface });
    expect(await cardText(pane, /Background one/)).toBe("  Background one");
    await pane.unmount();
    const band = await $.ui.mount({ ...BAND, surface });
    expect((await band.find({ type: "Text", text: /done/ }))?.text).toBe("▏ All 5 done");
    await band.unmount();
  }
});

test("a later session.start (reload, respawn) keeps the cards and the list", async ($, on) => {
  world(on, [agentInfo("a1", "Explore", "Kept")]);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.tool.call({ tool: "TodoWrite", todos: FIVE });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await cardText(pane, /Kept/)).toBe("  Kept");
  await pane.unmount();
  const band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect((await band.find({ type: "Text", text: /3\/5/ }))?.text).toBe("▏ 3/5  Running tests");
  await band.unmount();
});

// --- Amendment 1: the own progress tool and its two reminders ---------------

const PROGRESS = "mcp__task-bar__progress";
const REMINDER_START =
  "task-bar: this looks like a multi-step task. If it has three or more steps, send them with the progress tool so the person can follow along.";
const REMINDER_STALE =
  "task-bar: the progress list has not changed for a while. If an item started or finished, send the updated list with the progress tool.";

const progress = (input: Record<string, unknown>, agentId?: string) =>
  ({ tool: PROGRESS, ...input, ...(agentId === undefined ? {} : { agentId }) }) as never;

const FIVE_ITEMS = [
  { label: "Read the code", state: "done" },
  { label: "Write the fix", state: "done" },
  { label: "Write a test", state: "done" },
  { label: "Running tests", state: "doing" },
  { label: "Open a PR", state: "todo" },
];

/** Starts a session where the built-in to-do tools are missing. */
const withoutBuiltins = async (
  $: Engine,
  on: On,
  agents: AgentInfo[] = [],
): Promise<World> => {
  const engine = world(on, agents, { hasBuiltinTodos: false });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  return engine;
};

/** Reports `count` finished Bash calls and returns each one's added context. */
const bashCalls = async (
  $: Engine,
  count: number,
  agentId?: string,
): Promise<(readonly string[] | undefined)[]> => {
  const contexts: (readonly string[] | undefined)[] = [];

  for (let i = 0; i < count; i += 1) {
    contexts.push(await finished($, "Bash", agentId));
  }

  return contexts;
};

test("progress is registered only where the built-in to-do tools are missing", async ($, on) => {
  const engine = world(on, [], { hasBuiltinTodos: false });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  expect(engine.registered).toHaveLength(1);
  expect(engine.registered[0]?.name).toBe("progress");
  expect(engine.registered[0]?.description).toBe(
    "Show the person how far you are with a task of three or more steps. Send the whole list every time, in order, each item with its state. Call it when you start, and again each time an item starts or finishes.",
  );
  expect(engine.registered[0]?.inputSchema).toEqual({
    type: "object",
    properties: {
      goal: { type: "string", description: "The task in a few words" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            state: { enum: ["todo", "doing", "done"] },
          },
          required: ["label", "state"],
        },
      },
    },
    required: ["items"],
  });
});

test("progress is not registered where the built-in to-do tools exist", async ($, on) => {
  const engine = world(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  expect(engine.registered).toEqual([]);
});

test("a progress call with 5 items draws 3/5, the goal and the doing label", async ($, on) => {
  await withoutBuiltins($, on);
  const ran = await $.tool.call(progress({ goal: "Refactor auth", items: FIVE_ITEMS }));

  expect(ran).toEqual({ result: "Saved: 3 of 5 done." });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: "Text", text: /3\/5/ }))?.text).toBe(
      "▏ 3/5  Refactor auth · Running tests",
    );
    await ui.unmount();

    // Where goal and item do not both fit, the item alone is shown.
    const narrow = await $.ui.mount({
      ...BAND,
      surface,
      props: { ...BAND.props, bodyColumns: 40 },
    });
    expect((await narrow.find({ type: "Text", text: /3\/5/ }))?.text).toBe(
      "▏ 3/5  Running tests",
    );
    await narrow.unmount();
  }
});

test("invalid progress input gives the error result and leaves the state unchanged", async ($, on) => {
  await withoutBuiltins($, on);
  await $.tool.call(progress({ goal: "Refactor auth", items: FIVE_ITEMS }));

  for (const input of [
    {},
    { items: "three steps" },
    { items: [{ label: "x", state: "started" }] },
    { items: [{ state: "done" }] },
  ]) {
    expect(await $.tool.call(progress(input))).toEqual({
      deny: "progress: items must be a list of { label, state }",
    });
  }

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface });
    expect((await ui.find({ type: "Text", text: /\/5/ }))?.text).toBe(
      "▏ 3/5  Refactor auth · Running tests",
    );
    await ui.unmount();
  }
});

test("empty progress items clear the list", async ($, on) => {
  await withoutBuiltins($, on);
  await $.tool.call(progress({ goal: "Refactor auth", items: FIVE_ITEMS }));
  expect(await $.tool.call(progress({ items: [] }))).toEqual({
    result: "Saved: 0 of 0 done.",
  });

  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.keepsBeneath()).toBe(true);
  await ui.unmount();
});

test("a subagent progress call fills its card, not the bar", async ($, on) => {
  await withoutBuiltins($, on, [agentInfo("a1", "Explore", "Map it")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.tool.call(
    progress(
      {
        items: [
          { label: "A", state: "done" },
          { label: "B", state: "doing" },
        ],
      },
      "a1",
    ),
  );

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface });
    expect(await band.keepsBeneath()).toBe(true);
    expect(await band.find({ type: "Text", text: /█|░/ })).toBeUndefined();
    await band.unmount();

    const pane = await $.ui.mount({ ...PANE, surface });
    expect((await pane.find({ type: "Text", text: /1\/2/ }))?.text).toBe("▏ 1/2");
    await pane.unmount();
  }
});

test("reminder 1 comes on the 4th call of a turn without a list, once", async ($, on) => {
  await withoutBuiltins($, on);
  const contexts = await bashCalls($, 12);

  expect(contexts[3]).toEqual([REMINDER_START]);
  expect(contexts.filter((one) => one !== undefined)).toHaveLength(1);
});

test("a reminder adds only context; the result is otherwise unchanged", async ($, on) => {
  await withoutBuiltins($, on);
  await bashCalls($, 3);

  expect(
    await $.classic.PostToolUse({
      tool_name: "Bash",
      tool_input: {},
      tool_response: {},
      tool_use_id: await responseRow($, "Bash"),
    }),
  ).toEqual({ additionalContext: [REMINDER_START] });
  expect(
    await $.classic.PostToolUse({
      tool_name: "Bash",
      tool_input: {},
      tool_response: {},
      tool_use_id: await responseRow($, "Bash"),
    }),
  ).toEqual({});
});

test("a failed main-loop call counts toward the reminders too", async ($, on) => {
  await withoutBuiltins($, on);
  await bashCalls($, 3);

  expect(await finished($, "Bash", undefined, { hasFailed: true })).toEqual([
    REMINDER_START,
  ]);
});

test("no tool.call hook of the mod hears an unrelated tool such as Bash", async ($, on) => {
  // What the engine answered comes back exactly, and the mod learns nothing of
  // the call at this point: no card count, no reminder. It hears Bash only
  // after the fact, through the classic events. (Validate lists the mod's
  // tool.call hooks as matched to the progress tool and the to-do tools.)
  await withoutBuiltins($, on, [agentInfo("a1", "Explore", "One")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });

  for (let i = 0; i < 4; i += 1) {
    expect(await $.tool.call({ tool: "Bash", command: "ls" })).toEqual({
      result: { ok: true },
    });
    await $.tool.call({ tool: "Bash", command: "ls", agentId: "a1" });
  }

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await cardText(ui, /tool calls/)).toBe("  0 tool calls");
  await ui.unmount();
});

test("reminder 2 comes after 8 calls with no progress update, at most once per 8", async ($, on) => {
  await withoutBuiltins($, on);
  const first = await $.tool.call(progress({ items: FIVE_ITEMS }));
  expect(first.context).toBeUndefined();

  const contexts = await bashCalls($, 16);

  expect(contexts[7]).toEqual([REMINDER_STALE]);
  expect(contexts[15]).toEqual([REMINDER_STALE]);
  expect(contexts.filter((one) => one !== undefined)).toHaveLength(2);

});

test("a progress call starts the stale count again", async ($, on) => {
  await withoutBuiltins($, on);
  await $.tool.call(progress({ items: FIVE_ITEMS }));
  const before = await bashCalls($, 5);
  await $.tool.call(progress({ items: FIVE_ITEMS }));
  const after = await bashCalls($, 7);

  expect([...before, ...after].filter((one) => one !== undefined)).toHaveLength(0);
  expect(await bashCalls($, 1)).toEqual([[REMINDER_STALE]]);
});

test("no reminder once the list is all done this turn", async ($, on) => {
  await withoutBuiltins($, on);
  await $.tool.call(
    progress({ items: FIVE_ITEMS.map((one) => ({ ...one, state: "done" })) }),
  );

  const contexts = await bashCalls($, 16);
  expect(contexts.filter((one) => one !== undefined)).toHaveLength(0);

  // Reopened in the same turn: still none until the next prompt.
  await $.tool.call(progress({ items: FIVE_ITEMS }));
  const reopened = await bashCalls($, 16);
  expect(reopened.filter((one) => one !== undefined)).toHaveLength(0);
});

test("no reminders in subagents or where the built-in to-do tools exist", async ($, on) => {
  await withoutBuiltins($, on, [agentInfo("a1", "Explore", "Map it")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  const inAgent = await bashCalls($, 12, "a1");

  expect(inAgent.filter((one) => one !== undefined)).toHaveLength(0);
});

test("no reminders while the progress tool is not registered", async ($, on) => {
  world(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  const contexts = await bashCalls($, 12);

  expect(contexts.filter((one) => one !== undefined)).toHaveLength(0);
});

test("the reminder counters start over at every prompt", async ($, on) => {
  await withoutBuiltins($, on);
  await bashCalls($, 3);
  await $.prompt.submit({
    text: "<task-notification>",
    wait: false,
    isMeta: true,
    origin: { kind: "task-notification" },
  });
  const contexts = await bashCalls($, 4);

  expect(contexts.slice(0, 3).filter((one) => one !== undefined)).toHaveLength(0);
  expect(contexts[3]).toEqual([REMINDER_START]);
});

// --- Review notes on amendment 1 --------------------------------------------

test("a denied call uses up no reminder: reminder 1 comes on the next call", async ($, on) => {
  const engine = await withoutBuiltins($, on);
  const first = await bashCalls($, 3);
  engine.failNext.set("Bash", { deny: "not here" });
  const denied = await $.tool.call({ tool: "Bash", command: "rm -rf /" });
  const next = await bashCalls($, 1);

  expect(first.filter((one) => one !== undefined)).toHaveLength(0);
  expect(denied).toEqual({ deny: "not here" });
  expect(next).toEqual([[REMINDER_START]]);
});

test("a ping from Slack is the person's prompt: finished cards go", async ($, on) => {
  world(on, [agentInfo("a1", "Explore", "Finished")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.turn.complete({
    answer: "",
    durationMs: 5,
    isAborted: false,
    turnId: "t1",
    agentId: "a1",
    reason: "answer",
  });
  await $.prompt.submit({ text: "hi", wait: false, origin: { kind: "slack-ping" } });

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await pane.find({ type: "Text" }))?.text).toBe("No subagents in this chat yet.");
  await pane.unmount();
});

test("only the name the engine registered is served", async ($, on) => {
  // Should the engine answer another name, the default one is not served.
  world(on, [], { hasBuiltinTodos: false, registeredAs: () => "mcp__task-bar__progress_2" });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  expect(await $.tool.call(progress({ items: FIVE_ITEMS }))).toEqual({ result: { ok: true } });
  const band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await band.keepsBeneath()).toBe(true);
  await band.unmount();

  // Nor is any reminder sent that points to a tool nobody answers.
  expect(reminders(await bashCalls($, 12))).toEqual([]);
});

test("another plugin's progress tool is never answered", async ($, on) => {
  await withoutBuiltins($, on);

  for (const tool of ["mcp__my-task-bar__progress", "mcp__task-bar-x__progress", "mcp__other__progress"]) {
    expect(await $.tool.call({ tool, items: FIVE_ITEMS } as never)).toEqual({
      result: { ok: true },
    });
  }

  const band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await band.keepsBeneath()).toBe(true);
  await band.unmount();
});

test("the progress tool is not answered while it is not registered", async ($, on) => {
  // The built-in to-do tools exist, so this load registered nothing.
  world(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

  expect(await $.tool.call(progress({ items: FIVE_ITEMS }))).toEqual({ result: { ok: true } });
});

test("a subagent's progress call counts on its card", async ($, on) => {
  await withoutBuiltins($, on, [agentInfo("a1", "Explore", "Map it")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.tool.call(progress({ items: [{ label: "A", state: "doing" }] }, "a1"));

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface });
    expect((await pane.find({ type: "Text", text: /tool call/ }))?.text).toBe(
      `  1 tool call · last: ${PROGRESS}`,
    );
    await pane.unmount();
  }
});

test("a progress call is answered even when the state cannot be written", async ($, on) => {
  on("state.set", { key: "tasks" }, () => ({ deny: "state is read-only here" }));
  await withoutBuiltins($, on);

  expect(await $.tool.call(progress({ items: FIVE_ITEMS }))).toEqual({
    result: "Saved: 3 of 5 done.",
  });
});

test("a resume resets the state, as /clear does", async ($, on) => {
  world(on, [agentInfo("a1", "Explore", "Old chat")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.tool.call({ tool: "TodoWrite", todos: FIVE });
  await $.session.end({ reason: "resume", sessionId: "s1", resume: {} as never });

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await pane.find({ type: "Text" }))?.text).toBe("No subagents in this chat yet.");
  await pane.unmount();
  const band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await band.keepsBeneath()).toBe(true);
  await band.unmount();
});

test("a progress call is counted once, where it is answered, never again after the fact", async ($, on) => {
  await withoutBuiltins($, on, [agentInfo("a1", "Explore", "One")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await $.tool.call(progress({ items: [{ label: "A", state: "doing" }] }, "a1"));
  await finished($, PROGRESS, "a1");

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /tool call/ }))?.text).toBe(
    `  1 tool call · last: ${PROGRESS}`,
  );
  await ui.unmount();

  // Nor does it count toward the main loop's reminders.
  await bashCalls($, 3);
  expect(await finished($, PROGRESS)).toBeUndefined();
  expect(await bashCalls($, 1)).toEqual([[REMINDER_START]]);
});

// --- Amendment 2: cards with a border and a tint by status -----------------

test("each card is a padded round box in its status colour, border to border", async ($, on) => {
  const engine = world(on, [
    agentInfo("a1", "Explore", "Done one"),
    agentInfo("a2", "Plan", "Failed one"),
    agentInfo("a3", "Explore", "Running one"),
  ]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  await engine.advance(1000);
  await $.turn.start({ text: "go", turnId: "t2", agentId: "a2" });
  await engine.advance(1000);
  await $.turn.start({ text: "go", turnId: "t3", agentId: "a3" });
  for (const [turnId, agentId, reason] of [
    ["t1", "a1", "answer"],
    ["t2", "a2", "error"],
  ] as const) {
    await $.turn.complete({ answer: "", durationMs: 5, isAborted: false, turnId, agentId, reason });
  }

  for (const surface of SURFACES) {
    for (const bodyColumns of [60, 24]) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns } });
      const cards = (await ui.findAll({ type: "Box" })).filter(
        (box) => box.props.borderStyle !== undefined,
      );
      // The tint fills the whole card on desktop; the terminal draws none.
      const tint = (name: string) => (surface === "desktop" ? name : undefined);

      // Newest first: running, failed, done; no margin between them.
      expect(
        cards.map((box) => [
          box.props.borderStyle,
          box.props.borderColor,
          box.props.paddingX,
          box.props.backgroundColor,
          box.props.marginTop ?? 0,
          box.props.marginBottom ?? 0,
        ]),
      ).toEqual([
        ["round", "claude", 1, undefined, 0, 0],
        ["round", "error", 1, tint("diffRemovedDimmed"), 0, 0],
        ["round", "success", 1, tint("diffAddedDimmed"), 0, 0],
      ]);

      // Line 1: the dot, the type in bold, and the status and time on the
      // right, both in the status colour.
      const dots = await ui.findAll({ type: "Text", text: /●/ });
      expect(dots.map((one) => one.props.color)).toEqual(["claude", "error", "success"]);
      const types = await ui.findAll({ type: "Text", text: /^(Explore|Plan)$/ });
      expect(types.map((one) => [one.text, one.props.weight])).toEqual([
        ["Explore", "bold"],
        ["Plan", "bold"],
        ["Explore", "bold"],
      ]);
      const statuses = await ui.findAll({ type: "Text", text: /^ (running|done|failed) / });
      expect(statuses.map((one) => [one.text, one.props.color])).toEqual([
        [" running 0s", "claude"],
        [" failed 1s", "error"],
        [" done 2s", "success"],
      ]);
      // Lines 2 and 3: the description, then the calls, dim.
      const calls = await ui.findAll({ type: "Text", text: /tool calls/ });
      expect(calls.map((one) => [one.text, one.props.dimColor])).toEqual([
        ["  0 tool calls", true],
        ["  0 tool calls", true],
        ["  0 tool calls", true],
      ]);
      expect(await cardText(ui, /Running one/)).toBe("  Running one");
      await ui.unmount();
    }
  }
});

// --- Review 3: parallel PostToolUse hooks, unknown agents -------------------

const parallel = async ($: Engine, count: number) =>
  Promise.all(Array.from({ length: count }, () => finished($, "Bash")));

const reminders = (contexts: readonly (readonly string[] | undefined)[]) =>
  contexts.filter((one) => one !== undefined);

test("4 parallel calls with no list get reminder 1 exactly once", async ($, on) => {
  await withoutBuiltins($, on);

  expect(reminders(await parallel($, 4))).toEqual([[REMINDER_START]]);
  expect(reminders(await bashCalls($, 6))).toEqual([]);
});

test("2 sequential calls then 3 parallel get reminder 1 exactly once", async ($, on) => {
  await withoutBuiltins($, on);
  const first = await bashCalls($, 2);
  const batch = await parallel($, 3);

  expect(reminders([...first, ...batch])).toEqual([[REMINDER_START]]);
});

test("a list, 6 sequential calls then 4 parallel get reminder 2 exactly once", async ($, on) => {
  await withoutBuiltins($, on);
  await $.tool.call(progress({ items: FIVE_ITEMS }));
  const first = await bashCalls($, 6);
  const batch = await parallel($, 4);

  expect(reminders([...first, ...batch])).toEqual([[REMINDER_STALE]]);
});

test("a call of an unknown agent writes no card state", async ($, on) => {
  let writes = 0;
  on("state.set", { key: "agents" }, (_, e, next) => {
    writes += 1;

    return next(e);
  });
  world(on, [agentInfo("a1", "Explore", "One")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  const before = writes;

  await finished($, "Bash", "ghost");
  await finished($, "Bash", "ghost", { hasFailed: true });
  await $.turn.complete({
    answer: "",
    durationMs: 5,
    isAborted: false,
    turnId: "t9",
    agentId: "ghost",
    reason: "answer",
  });

  expect(writes - before).toBe(0);
  // A known agent still writes.
  await finished($, "Bash", "a1");
  expect(writes - before).toBe(1);
});

test("a 4th call racing a main-loop progress call gets no reminder", async ($, on) => {
  // Holds the 4th call's read of the list until a progress call has landed.
  let isHolding = false;
  let reached = (): void => undefined;
  let release = (): void => undefined;
  const hasReached = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  on("state.get", { key: "tasks" }, async (_, e, next) => {
    if (isHolding) {
      isHolding = false;
      reached();
      await gate;
    }

    return next(e);
  });
  await withoutBuiltins($, on);
  await bashCalls($, 3);

  isHolding = true;
  const fourth = finished($, "Bash");
  await hasReached;
  // With an empty list the 4th call would get reminder 1; the progress call
  // that lands meanwhile empties it again, so only the epoch can stop it.
  await $.tool.call(progress({ items: [] }));
  release();

  expect(await fourth).toBeUndefined();
});

// --- Live look: subagent counts, full-width bar ------------------------------

test("a subagent's calls count from its result rows, whatever PostToolUse says", async ($, on) => {
  // Live, every card kept 0 tool calls: the classic events gave no agent_id
  // the card is known by. The result rows carry the loop's own id.
  world(on, [agentInfo("a1", "Explore", "Count tests")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });

  for (const tool of ["Glob", "Read", "Grep"]) {
    await $.classic.PostToolUse({
      tool_name: tool,
      tool_input: {},
      tool_response: {},
      tool_use_id: "toolu_x",
    });
    await toolResultRow($, tool, "a1");
  }

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await cardText(ui, /tool calls/)).toBe("  3 tool calls · last: Grep");
    await ui.unmount();
  }
});

test("a subagent call is not counted twice when PostToolUse names it too", async ($, on) => {
  world(on, [agentInfo("a1", "Explore", "Count tests")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  // `finished` raises both the classic event with agent_id and the row.
  await finished($, "Read", "a1");

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await cardText(ui, /tool call/)).toBe("  1 tool call · last: Read");
  await ui.unmount();
});

test("the bar fills the band's width, keeping 10 cells and clipping the text first", async ($, on) => {
  world(on);
  await $.tool.call({ tool: "TodoWrite", todos: FIVE });

  for (const surface of SURFACES) {
    for (const bodyColumns of [120, 60, 30]) {
      const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns } });
      const filled = (await ui.find({ type: "Text", text: "█" }))?.text ?? "";
      const empty = (await ui.find({ type: "Text", text: "░" }))?.text ?? "";
      const tail = (await ui.find({ type: "Text", text: /3\/5/ }))?.text ?? "";

      expect(1 + filled.length + empty.length + tail.length).toBe(bodyColumns);
      expect(filled.length + empty.length).toBeGreaterThanOrEqual(10);

      if (bodyColumns === 30) {
        // 30 - 1 - 10 - "▏ 3/5" - 2 leave 12: the text is clipped, the bar is 10.
        expect(filled.length + empty.length).toBe(10);
        expect(tail).toBe("▏ 3/5  Running tes…");
      }

      await ui.unmount();
    }
  }
});

test("the goal row and the done row fill the band's width too", async ($, on) => {
  await withoutBuiltins($, on);
  await $.tool.call(progress({ goal: "Refactor auth", items: FIVE_ITEMS }));

  for (const surface of SURFACES) {
    for (const bodyColumns of [120, 60, 30]) {
      const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns } });
      const filled = (await ui.find({ type: "Text", text: "█" }))?.text ?? "";
      const empty = (await ui.find({ type: "Text", text: "░" }))?.text ?? "";
      const tail = (await ui.find({ type: "Text", text: /3\/5/ }))?.text ?? "";

      expect(1 + filled.length + empty.length + tail.length).toBe(bodyColumns);
      // The goal shows where it fits whole beside the item, and is dropped
      // before the item is clipped.
      expect(tail).toBe(
        bodyColumns === 30
          ? "▏ 3/5  Running tes…"
          : "▏ 3/5  Refactor auth · Running tests",
      );
      await ui.unmount();
    }
  }

  await $.tool.call(
    progress({ items: FIVE_ITEMS.map((one) => ({ ...one, state: "done" })) }),
  );

  for (const surface of SURFACES) {
    for (const bodyColumns of [120, 60, 30]) {
      const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns } });
      const bar = (await ui.find({ type: "Text", text: "█" }))?.text ?? "";
      const tail = (await ui.find({ type: "Text", text: /done/ }))?.text ?? "";

      expect(tail).toBe("▏ All 5 done");
      expect(1 + bar.length + tail.length).toBe(bodyColumns);
      await ui.unmount();
    }
  }
});

// --- Probe finding: PostToolUse may name no loop -----------------------------

test("a subagent's call that PostToolUse names without agent_id gets no reminder", async ($, on) => {
  await withoutBuiltins($, on, [agentInfo("a1", "Explore", "One")]);
  await $.turn.start({ text: "go", turnId: "t1", agentId: "a1" });
  const contexts: (readonly string[] | undefined)[] = [];

  for (let i = 0; i < 12; i += 1) {
    // The subagent's own response asks for the call; PostToolUse then comes
    // without agent_id, as if it were the main loop's.
    const toolUseId = await responseRow($, "Bash", "a1");
    const answer = await $.classic.PostToolUse({
      tool_name: "Bash",
      tool_input: {},
      tool_response: {},
      tool_use_id: toolUseId,
    });
    contexts.push(answer.additionalContext);
  }

  expect(reminders(contexts)).toEqual([]);
  // Nor did those calls count toward the main loop's: its 4th call reminds.
  expect(reminders(await bashCalls($, 4))).toEqual([[REMINDER_START]]);
  expect((await bashCalls($, 4))[3]).toBeUndefined();
});

test("a PostToolUse for a call no main-loop response asked for gets no reminder", async ($, on) => {
  await withoutBuiltins($, on);
  const contexts: (readonly string[] | undefined)[] = [];

  for (let i = 0; i < 8; i += 1) {
    const answer = await $.classic.PostToolUse({
      tool_name: "Bash",
      tool_input: {},
      tool_response: {},
      tool_use_id: `toolu_unknown_${i}`,
    });
    contexts.push(answer.additionalContext);
  }

  expect(reminders(contexts)).toEqual([]);
});

test("a PostToolUse that lands while its response row is still being stored is known", async ($, on) => {
  // Holds the main loop's response row beneath the mod, as a slow store would.
  let isHolding = false;
  let reached = (): void => undefined;
  let release = (): void => undefined;
  const hasReached = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  on("session.append", { door: "response" }, async (_, e, next) => {
    if (isHolding) {
      isHolding = false;
      reached();
      await gate;
    }

    return next(e);
  });
  await withoutBuiltins($, on);
  await bashCalls($, 3);

  isHolding = true;
  const storing = $.session.append({
    message: {
      type: "assistant",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_slow", name: "Bash", input: {} }],
    },
    door: "response",
    origin: { kind: "model", model: "claude" },
    uuid: "row-slow",
  } as never);
  await hasReached;
  const answer = await $.classic.PostToolUse({
    tool_name: "Bash",
    tool_input: {},
    tool_response: {},
    tool_use_id: "toolu_slow",
  });
  release();
  await storing;

  expect(answer.additionalContext).toEqual([REMINDER_START]);
});

// Amendment 4: the band layout.

type BandRow = { plugin: string; tree: RenderElement };

const bandRow = (plugin: string): BandRow => ({
  plugin,
  tree: {
    type: "Box",
    props: { flexDirection: "row" },
    children: [
      { type: "Text", props: { bold: true }, children: [`${plugin} row`] },
    ],
  },
});

const LIST = (rows: readonly BandRow[], bodyColumns: number) =>
  ({
    plugin: "task-bar",
    component: "AbovePromptList",
    props: { ...BAND.props, bodyColumns, rows },
  }) as const;

/**
 * Stands in for core beneath the mod: records the rows each `next` hands it
 * and stacks them as core does (one row alone is its own tree).
 */
const core = (on: On, { failSingle = false } = {}) => {
  const received: BandRow[][] = [];
  on("ui.render", { component: "AbovePromptList" }, (_, e) => {
    const rows = e.props.rows as readonly BandRow[];
    received.push([...rows]);

    if (failSingle && rows.length === 1) {
      throw new Error("refused");
    }

    const [only] = rows;

    return rows.length === 1 && only !== undefined
      ? only.tree
      : {
          type: "Box",
          props: { flexDirection: "column" },
          children: rows.map((row) => row.tree),
        };
  });

  return received;
};

const plugins = (rows: readonly BandRow[]): string[] =>
  rows.map((row) => row.plugin);

test("at 120 columns fresh-start and cache-timer sit side by side, task-bar last, on every surface", async ($, on) => {
  const received = core(on);
  const rows = ["task-bar", "other", "cache-timer", "fresh-start"].map(bandRow);

  for (const surface of SURFACES) {
    received.length = 0;
    const ui = await $.ui.mount({ ...LIST(rows, 120), surface });

    expect(received.map(plugins)).toEqual([
      ["fresh-start"],
      ["cache-timer"],
      ["other", "task-bar"],
    ]);
    const drawn = await ui.drawn();
    expect(drawn).toMatchObject({
      type: "Box",
      props: { flexDirection: "column" },
      children: [
        {
          type: "Box",
          props: { flexDirection: "row", gap: 1 },
          children: [bandRow("fresh-start").tree, bandRow("cache-timer").tree],
        },
        {
          type: "Box",
          children: [bandRow("other").tree, bandRow("task-bar").tree],
        },
      ],
    });
    await ui.unmount();
  }
});

test("at 80 columns the rows stack: top two, the rest, task-bar last, on every surface", async ($, on) => {
  const received = core(on);
  const rows = ["task-bar", "other", "cache-timer", "fresh-start"].map(bandRow);

  for (const surface of SURFACES) {
    received.length = 0;
    const ui = await $.ui.mount({ ...LIST(rows, 80), surface });

    expect(received.map(plugins)).toEqual([
      ["fresh-start", "cache-timer", "other", "task-bar"],
    ]);
    expect(await ui.drawn()).toMatchObject({
      type: "Box",
      props: { flexDirection: "column" },
      children: ["fresh-start", "cache-timer", "other", "task-bar"].map(
        (name) => bandRow(name).tree,
      ),
    });
    await ui.unmount();
  }
});

test("side by side needs both top rows; one alone stacks on top", async ($, on) => {
  const received = core(on);

  for (const surface of SURFACES) {
    received.length = 0;
    const ui = await $.ui.mount({
      ...LIST(["task-bar", "fresh-start"].map(bandRow), 120),
      surface,
    });
    expect(received.map(plugins)).toEqual([["fresh-start", "task-bar"]]);
    await ui.unmount();
  }
});

test("other plugins' rows keep their order, between the top and task-bar", async ($, on) => {
  const received = core(on);
  const ui = await $.ui.mount({
    ...LIST(
      ["zeta", "task-bar", "alpha", "cache-timer", "mid"].map(bandRow),
      120,
    ),
    surface: "terminal",
  });

  expect(received.map(plugins)).toEqual([
    ["cache-timer", "zeta", "alpha", "mid", "task-bar"],
  ]);
  await ui.unmount();
});

test("no rows or one plugin's row go on unchanged", async ($, on) => {
  const received = core(on);

  for (const rows of [[], [bandRow("cache-timer")], [bandRow("task-bar")]]) {
    received.length = 0;
    const ui = await $.ui.mount({ ...LIST(rows, 120), surface: "terminal" });
    expect(received).toEqual([rows]);
    await ui.unmount();
  }
});

test("rows are never changed or repeated, only moved", async ($, on) => {
  const received = core(on);
  const rows = ["other", "task-bar", "fresh-start", "cache-timer", "more"].map(
    bandRow,
  );

  for (const columns of [120, 80]) {
    received.length = 0;
    const ui = await $.ui.mount({
      ...LIST(rows, columns),
      surface: "terminal",
    });
    const handed = received.flat();

    // Every row handed on exactly once, each equal by value to its original.
    expect(handed.length).toBe(rows.length);
    for (const row of rows) {
      expect(handed.filter((one) => one.plugin === row.plugin)).toEqual([row]);
    }
    await ui.unmount();
  }
});

test("rows the engine stacks itself still sit side by side, on every surface", async ($, on) => {
  // Beneath refuses each single row, so the engine's own nodes come back from
  // `next`; the wrapper around them must still validate (no width of ours).
  const received = core(on, { failSingle: true });
  const rows = ["task-bar", "cache-timer", "fresh-start"].map(bandRow);

  for (const surface of SURFACES) {
    received.length = 0;
    const ui = await $.ui.mount({ ...LIST(rows, 120), surface });

    expect(received.map(plugins)).toEqual([
      ["fresh-start"],
      ["cache-timer"],
      ["task-bar"],
    ]);
    expect(await ui.drawn()).toMatchObject({
      type: "Box",
      props: { flexDirection: "column" },
      children: [
        {
          type: "Box",
          props: { flexDirection: "row", gap: 1 },
          children: [bandRow("fresh-start").tree, bandRow("cache-timer").tree],
        },
        bandRow("task-bar").tree,
      ],
    });
    await ui.unmount();
  }
});
