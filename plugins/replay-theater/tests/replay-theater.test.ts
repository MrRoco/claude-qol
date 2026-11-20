import { expect, test } from "claude-code/testing";
import type { Engine, Mounted } from "claude-code/testing";
import type { On } from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;
type Surface = (typeof SURFACES)[number];

const ROOT = "/work/project";
const PANE_ID = "replay-theater";

const REPLAY = {
  command: "replay",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 160 },
} as const;

const BAND = {
  plugin: "replay-theater",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

const PANE = {
  plugin: "replay-theater",
  component: "Pane",
  requestId: PANE_ID,
  props: {
    title: "Replay",
    isFocused: true,
    bodyColumns: 58,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 22 },
    view: {},
  },
} as const;

type World = {
  opened: string[];
  closed: string[];
  registered: { name: string; description: string }[];
};

type WorldOptions = {
  // Files that exist before the turn, by absolute path, with their text.
  files?: Record<string, string>;
  // Whether the surface can place the pane.
  isPlaced?: boolean;
};

/**
 * Stands in for the engine beneath the mod: each hook answers as the engine
 * would and records what the mod asked for.
 */
const world = (on: On, options: WorldOptions = {}): World => {
  const files = options.files ?? {};
  const result: World = { opened: [], closed: [], registered: [] };

  on("command.register", (_, e) => {
    result.registered.push({ name: e.name, description: e.description });

    return { value: { command: e.name } };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: ROOT }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("clock.sleep", () => ({ value: undefined }));
  on("ui.open", (_, e) => {
    result.opened.push(e.id);

    return options.isPlaced === false
      ? { value: { isPlaced: false as const, reason: "narrow terminal" } }
      : { value: { isPlaced: true as const } };
  });
  on("ui.close", (_, e) => {
    result.closed.push(e.id);

    return { value: undefined };
  });
  on("fs.exists", (_, e) => ({ value: files[e.path] !== undefined }));
  on("fs.read", (_, e) => ({ value: files[e.path] ?? "" }));
  on("tool.call", () => ({ result: { ok: true } }));

  return result;
};

/** MultiEdit is not in the 2.1.328 tool types, so its call is cast. */
const multiEdit = (
  $: Engine,
  file: string,
  edits: { old_string: string; new_string: string }[],
  agentId?: string,
) =>
  $.tool.call({
    tool: "MultiEdit",
    file_path: file,
    edits,
    ...(agentId === undefined ? {} : { agentId }),
  } as unknown as Parameters<Engine["tool"]["call"]>[0]);

const completeTurn = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.complete({
    answer: "done",
    durationMs: 10,
    isAborted: false,
    turnId,
    reason: "answer",
    ...(agentId === undefined ? {} : { agentId }),
  });

/**
 * A main turn with one Edit (+2 -1), one Write over an existing file (+0 -1)
 * and one MultiEdit (+1 -0), plus a subagent's edit that must be ignored.
 */
const threeEditTurn = async ($: Engine) => {
  await $.turn.start({ text: "go", turnId: "t1" });
  await $.tool.call({
    tool: "Edit",
    file_path: `${ROOT}/src/a.ts`,
    old_string: "one\ntwo",
    new_string: "one\n2\nzwei",
  });
  await $.tool.call({
    tool: "Write",
    file_path: `${ROOT}/src/b.ts`,
    content: "x\n",
  });
  await multiEdit($, `${ROOT}/src/c.ts`, [
    { old_string: "", new_string: "new line" },
  ]);
  // A subagent edits too, inside the main turn: left out of the replay.
  await $.turn.start({ text: "sub", turnId: "s1", agentId: "agent-1" });
  await $.tool.call({
    tool: "Edit",
    file_path: `${ROOT}/src/sub.ts`,
    old_string: "a",
    new_string: "b",
    agentId: "agent-1",
  });
  await completeTurn($, "s1", "agent-1");
  await completeTurn($, "t1");
};

const FILES = { [`${ROOT}/src/b.ts`]: "x\ny\n" };

/** Every Text whose whole shown text is exactly `text`. */
const exact = async <S extends Surface, C extends "Pane" | "AbovePrompt">(
  ui: Mounted<S, C>,
  text: string,
) =>
  (await ui.findAll({ type: "Text", text })).filter((one) => one.text === text);

const onPane = async (
  $: Engine,
  surface: Surface,
  body: (ui: Mounted<Surface, "Pane">) => Promise<void>,
) => {
  const ui = await $.ui.mount({ ...PANE, surface });
  await body(ui);
  await ui.unmount();
};

const onBand = async (
  $: Engine,
  surface: Surface,
  body: (ui: Mounted<Surface, "AbovePrompt">) => Promise<void>,
) => {
  const ui = await $.ui.mount({ ...BAND, surface });
  await body(ui);
  await ui.unmount();
};

test("session start registers /replay with its own description", async ($, on) => {
  const engine = world(on);
  await $.session.start({
    cwd: ROOT,
    surface: "terminal",
    isInteractive: true,
  });

  expect(engine.registered).toEqual([
    { name: "replay", description: "Step through the last turn's file edits" },
  ]);
});

test("Edit, Write and MultiEdit in a main turn give a 3-edit hint; subagent edits are ignored", async ($, on) => {
  world(on, { files: FILES });

  await $.turn.start({ text: "go", turnId: "t1" });
  await $.tool.call({
    tool: "Edit",
    file_path: `${ROOT}/a.ts`,
    old_string: "a",
    new_string: "b",
  });

  // Nothing shows until the turn completes.
  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }

  await threeEditTurn($);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      const hint = await ui.find({ type: "Text", text: /file edit/ });
      expect(hint?.text).toBe("▶ 3 file edits in the last turn");
      expect(hint?.props.color).toBe("claude");
      expect(hint?.props.weight).toBe("bold");
      const button = await ui.find({ type: "Button", key: "open-replay" });
      expect(button?.text).toBe("Replay");
    });
  }
});

test("one edit reads in the singular", async ($, on) => {
  world(on);
  await $.turn.start({ text: "go", turnId: "t1" });
  await $.tool.call({
    tool: "Edit",
    file_path: `${ROOT}/a.ts`,
    old_string: "a",
    new_string: "b",
  });
  await completeTurn($, "t1");

  await onBand($, "terminal", async (ui) => {
    expect((await ui.find({ type: "Text", text: /file edit/ }))?.text).toBe(
      "▶ 1 file edit in the last turn",
    );
  });
  expect((await $.command.run(REPLAY)).text).toBe("Replaying 1 edit.");
});

test("a turn made only of subagent edits shows nothing", async ($, on) => {
  const engine = world(on);
  await $.turn.start({ text: "go", turnId: "t1" });
  await $.tool.call({
    tool: "Write",
    file_path: `${ROOT}/sub.ts`,
    content: "hi\n",
    agentId: "agent-1",
  });
  await completeTurn($, "t1");

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }

  const reply = await $.command.run(REPLAY);
  expect(reply.text).toBe("The last turn made no file edits.");
  expect(engine.opened).toEqual([]);
});

test("recording never changes or blocks the edit", async ($, on) => {
  world(on);
  const answer = await $.tool.call({
    tool: "Edit",
    file_path: `${ROOT}/a.ts`,
    old_string: "a",
    new_string: "b",
  });

  expect(answer).toEqual({ result: { ok: true } });
});

test("/replay opens the pane, which steps forward and back with theme colours", async ($, on) => {
  const engine = world(on, { files: FILES });
  await threeEditTurn($);

  const reply = await $.command.run(REPLAY);
  expect(reply.text).toBe("Replaying 3 edits.");
  expect(engine.opened).toEqual([PANE_ID]);

  for (const surface of SURFACES) {
    // The band yields while the pane is open.
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });

    await onPane($, surface, async (ui) => {
      const heading = await ui.find({ type: "Text", text: "▶ Replay" });
      expect(heading?.props.color).toBe("claude");
      expect(heading?.props.weight).toBe("bold");

      // Step 1: the Edit.
      expect((await exact(ui, "edit 1 of 3"))[0]?.props.weight).toBe("bold");
      const path = (await exact(ui, "src/a.ts"))[0];
      expect(path?.props.weight).toBe("bold");
      expect(path?.props.color).toBeUndefined();
      expect((await exact(ui, "Edit"))[0]).toBeDefined();
      expect((await exact(ui, "+2"))[0]?.props.color).toBe("success");
      expect((await exact(ui, "-1"))[0]?.props.color).toBe("error");
      expect((await exact(ui, "- two"))[0]?.props.color).toBe("error");
      expect((await exact(ui, "+ zwei"))[0]?.props.color).toBe("success");
      expect((await exact(ui, "  one"))[0]?.props.dimColor).toBe(true);
      // The active step in the strip carries the theme colour.
      expect((await exact(ui, " 1 "))[0]?.props.color).toBe("claude");
      expect((await exact(ui, " 2 "))[0]?.props.color).toBeUndefined();

      // Step 2: the Write over an existing file, diffed against its text.
      await ui.press({ key: "next" });
      expect((await exact(ui, "edit 2 of 3"))[0]).toBeDefined();
      expect((await exact(ui, "src/b.ts"))[0]).toBeDefined();
      expect((await exact(ui, "Write · whole file"))[0]).toBeDefined();
      expect((await exact(ui, "+0"))[0]?.props.color).toBe("success");
      expect((await exact(ui, "-1"))[0]?.props.color).toBe("error");

      // Step 3: the MultiEdit; Next stays on the last step.
      await ui.press({ key: "next" });
      await ui.press({ key: "next" });
      expect((await exact(ui, "edit 3 of 3"))[0]).toBeDefined();
      expect((await exact(ui, "MultiEdit · change 1 of 1"))[0]).toBeDefined();
      expect((await exact(ui, "+1"))[0]?.props.color).toBe("success");
      expect((await exact(ui, "-0"))[0]?.props.color).toBe("error");
      expect((await exact(ui, "+ new line"))[0]?.props.color).toBe("success");

      // Previous walks back, and stops at the first step.
      await ui.press({ key: "prev" });
      expect((await exact(ui, "edit 2 of 3"))[0]).toBeDefined();
      await ui.press({ key: "prev" });
      await ui.press({ key: "prev" });
      expect((await exact(ui, "edit 1 of 3"))[0]).toBeDefined();

      const buttons = (await ui.findAll({ type: "Button" })).map(
        (one) => one.text,
      );
      expect(buttons).toEqual(["◀ Previous", "Next ▶", "Close"]);
    });
  }
});

test("the hint's Replay button opens the pane", async ($, on) => {
  const engine = world(on, { files: FILES });
  await threeEditTurn($);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "open-replay" });
  });

  expect(engine.opened).toEqual([PANE_ID]);
});

test("Close shuts the pane and brings the hint back", async ($, on) => {
  const engine = world(on, { files: FILES });
  await threeEditTurn($);
  await $.command.run(REPLAY);

  await onPane($, "desktop", async (ui) => {
    await ui.press({ key: "close" });
  });

  expect(engine.closed).toEqual([PANE_ID]);
  await onBand($, "desktop", async (ui) => {
    expect((await ui.find({ type: "Text", text: /file edit/ }))?.text).toBe(
      "▶ 3 file edits in the last turn",
    );
  });
});

test("without room for a pane the replay draws in the band", async ($, on) => {
  world(on, { files: FILES, isPlaced: false });
  await threeEditTurn($);
  await $.command.run(REPLAY);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(
        (await ui.find({ type: "Text", text: "▶ Replay" }))?.props.color,
      ).toBe("claude");
      expect((await exact(ui, "edit 1 of 3"))[0]).toBeDefined();
    });
  }
});

test("a new file, a replace-all edit and a long diff use their own notes", async ($, on) => {
  world(on);
  const long = Array.from({ length: 20 }, (_, n) => `line ${n + 1}`).join("\n");
  await $.turn.start({ text: "go", turnId: "t1" });
  await $.tool.call({
    tool: "Write",
    file_path: `${ROOT}/new.ts`,
    content: long,
  });
  await $.tool.call({
    tool: "Edit",
    file_path: `${ROOT}/a.ts`,
    old_string: "same",
    new_string: "same",
    replace_all: true,
  });
  await completeTurn($, "t1");
  await $.command.run(REPLAY);

  for (const surface of SURFACES) {
    await onPane($, surface, async (ui) => {
      expect((await exact(ui, "Write · new file"))[0]).toBeDefined();
      expect((await exact(ui, "+20"))[0]).toBeDefined();
      expect((await exact(ui, "  … 8 more lines"))[0]?.props.dimColor).toBe(
        true,
      );

      await ui.press({ key: "next" });
      expect((await exact(ui, "Edit · all occurrences"))[0]).toBeDefined();
      expect((await exact(ui, "  (no line changes)"))[0]).toBeUndefined();

      await ui.press({ key: "prev" });
    });
  }
});

test("a later turn without edits keeps the last replay; a new turn with edits replaces it", async ($, on) => {
  world(on, { files: FILES });
  await threeEditTurn($);

  await $.turn.start({ text: "talk", turnId: "t2" });
  await completeTurn($, "t2");

  await onBand($, "terminal", async (ui) => {
    expect((await ui.find({ type: "Text", text: /file edit/ }))?.text).toBe(
      "▶ 3 file edits in the last turn",
    );
  });

  await $.turn.start({ text: "again", turnId: "t3" });
  await $.tool.call({
    tool: "Edit",
    file_path: `${ROOT}/a.ts`,
    old_string: "a",
    new_string: "b",
  });
  await completeTurn($, "t3");

  await onBand($, "terminal", async (ui) => {
    expect((await ui.find({ type: "Text", text: /file edit/ }))?.text).toBe(
      "▶ 1 file edit in the last turn",
    );
  });
});
