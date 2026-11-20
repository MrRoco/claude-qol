import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

import { buildRows } from "../hooks/register";
import type { ListedPlugin, Seen } from "../hooks/register";

const SURFACES = ["terminal", "desktop"] as const;
const MODS = {
  command: "mods",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: true, columns: 200 },
} as const;

const PANE = {
  plugin: "mod-switch",
  component: "Pane",
  requestId: "mod-switch",
  props: {
    title: "Mods",
    isFocused: true,
    bodyColumns: 70,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

type Entry = {
  id: string;
  version?: string;
  scope: string;
  enabled: boolean;
  installPath?: string;
};

const MOD_HOOKS = '{ "modules": ["./register.tsx"] }';
const manifest = (description: string) =>
  JSON.stringify({ name: "x", description });

/** A plugin installed under /cache/<name>, with or without a hooks module. */
const installed = (
  id: string,
  {
    scope = "user",
    enabled = true,
    isMod = true,
    description = `About ${id}`,
  } = {},
): { entry: Entry; files: Record<string, string> } => {
  const folder = `/cache/${id.replace("@", "/")}`;
  const files: Record<string, string> = {
    [`${folder}/.claude-plugin/plugin.json`]: manifest(description),
  };

  if (isMod) {
    files[`${folder}/hooks/hooks.json`] = MOD_HOOKS;
  }

  return {
    entry: { id, version: "1.2.0", scope, enabled, installPath: folder },
    files,
  };
};

type WorldOptions = {
  plugins?: { entry: Entry; files: Record<string, string> }[];
  enabled?: Record<string, boolean>;
  listFails?: string;
  // What the CLI answers to an enable or disable, by id.
  refuse?: Record<string, string>;
  sets?: unknown;
  reloadFails?: boolean;
  // Holds the listing until this promise resolves.
  listWaits?: Promise<void>;
};

type World = {
  runs: string[][];
  toasts: string[];
  commands: string[];
  opened: { id: string; focus?: boolean; closeOnEscape?: boolean }[];
  store: Map<string, unknown>;
  // Lets a later listing succeed or fail.
  setListFails: (reason: string | undefined) => void;
};

const processResult = (stdout: string, exitCode = 0, stderr = "") => ({
  value: {
    exitCode,
    stdout,
    stderr,
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
});

/**
 * Stands in for the engine beneath the mod: the CLI, the files, the settings
 * and the store, each answering as the engine would and recording the asks.
 */
const world = (on: On, options: WorldOptions = {}): World => {
  const plugins = options.plugins ?? [];
  const files: Record<string, string> = Object.assign(
    {},
    ...plugins.map((one) => one.files),
  );
  let listFails = options.listFails;
  const result: World = {
    runs: [],
    toasts: [],
    commands: [],
    opened: [],
    store: new Map<string, unknown>(
      options.sets === undefined ? [] : [["sets", options.sets]],
    ),
    setListFails: (reason) => {
      listFails = reason;
    },
  };

  on("command.register", () => ({ value: { command: "mods" } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("ui.open", (_, e) => {
    result.opened.push(e);

    return { value: { isPlaced: true } };
  });
  on("ui.toast", (_, e) => {
    result.toasts.push(e.text);

    return { value: undefined };
  });
  on("command.run", (_, e) => {
    result.commands.push(e.command);

    if (e.command === "reload-plugins" && options.reloadFails === true) {
      throw new Error("not now");
    }

    return { text: "" };
  });
  on("process.run", async (_, e) => {
    const argv = [...e.argv];
    result.runs.push(argv);

    if (argv.join(" ") === "claude plugin list --json") {
      await options.listWaits;

      return listFails === undefined
        ? processResult(JSON.stringify(plugins.map((one) => one.entry)))
        : processResult("", 1, `${listFails}\nmore detail`);
    }

    const id = argv[3] ?? "";
    const refusal = options.refuse?.[id];

    return refusal === undefined
      ? processResult('{"outcome":"ok"}')
      : processResult(JSON.stringify({ outcome: "error", reason: refusal }), 1);
  });
  on("fs.exists", (_, e) => ({ value: e.path in files }));
  on("fs.read", (_, e) =>
    e.path in files ? { value: files[e.path] ?? "" } : { deny: "no such file" },
  );
  on("settings.read", () => ({
    value: { enabledPlugins: options.enabled ?? {} },
  }));
  on("store.get", (_, e) => ({ value: result.store.get(e.key) }));
  on("store.set", (_, e) => {
    result.store.set(e.key, e.value);

    return { value: undefined };
  });
  // The kit raises plugin.register for the mod under test alone, before its
  // module loads, so the merge is tested through buildRows below.
  on("plugin.register", () => ({ allow: true }));

  return result;
};

// The test runner has timers; the mod's type set (es2023 only) does not.
declare function setTimeout(callback: () => void, ms: number): unknown;

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs /mods and waits until the pane is past its loading row: the listing
 * runs after the command's reply, as the person sees it.
 */
const openPane = async ($: Engine) => {
  const reply = await $.command.run(MODS);

  for (let i = 0; i < 100; i += 1) {
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
    const isLoading = (await texts(ui)).includes("Looking for mods…");
    await ui.unmount();

    if (!isLoading) {
      break;
    }

    await pause(5);
  }

  return reply;
};

const texts = async (ui: {
  findAll: (q: { type: string }) => Promise<{ text: string }[]>;
}) => (await ui.findAll({ type: "Text" })).map((one) => one.text);

const QOL = installed("task-bar@qol");
const FRESH = installed("fresh-start@qol", {
  enabled: false,
  scope: "project",
});
const SKILLS = installed("notes@other", { isMod: false });
const SELF = installed("mod-switch@qol");

test("/mods opens the Mods pane with the focus and answers for the person", async ($, on) => {
  const engine = world(on, { plugins: [QOL] });

  const reply = await openPane($);

  expect(reply).toEqual({ text: "Mods pane opened.", isTextDisplayOnly: true });
  expect(engine.opened).toEqual([
    { id: "mod-switch", title: "Mods", focus: true, closeOnEscape: true },
  ]);
  expect(engine.runs[0]).toEqual(["claude", "plugin", "list", "--json"]);
});

test("the listing keeps mods, leaves out other plugins and sorts by name, on every surface", async ($, on) => {
  world(on, {
    plugins: [QOL, SKILLS, FRESH],
    enabled: { "task-bar@qol": true },
  });
  await openPane($);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const shown = await texts(ui);

    expect(shown).toContain("fresh-start");
    expect(shown).toContain("task-bar");
    expect(shown).not.toContain("notes");
    expect(shown.indexOf("fresh-start")).toBeLessThan(
      shown.indexOf("task-bar"),
    );
    expect(shown).toContain("  @qol · v1.2.0");
    expect(shown).toContain("About task-bar@qol");
    expect((await ui.find({ key: "task-bar@qol" }))?.text).toBe("● on");
    expect((await ui.find({ key: "fresh-start@qol" }))?.text).toBe("○ off");
    await ui.unmount();
  }
});

test("on/off follows the enabled setting over the CLI's own word", async ($, on) => {
  world(on, { plugins: [QOL], enabled: { "task-bar@qol": false } });
  await openPane($);

  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect((await ui.find({ key: "task-bar@qol" }))?.text).toBe("○ off");
  await ui.unmount();
});

test("locks: managed, session only and this mod show a reason instead of a button", async ($, on) => {
  const managed = installed("policy-mod@corp", { scope: "managed" });
  const inlineListed = installed("local-dev@inline", { scope: "session" });
  world(on, { plugins: [managed, inlineListed, SELF, QOL] });
  await openPane($);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const shown = await texts(ui);

    expect(await ui.find({ key: "policy-mod@corp" })).toBeUndefined();
    expect(await ui.find({ key: "local-dev@inline" })).toBeUndefined();
    expect(await ui.find({ key: "mod-switch@qol" })).toBeUndefined();
    expect(shown).toContain("managed");
    expect(shown).toContain("session only");
    expect(shown).toContain("this mod");
    expect(await ui.find({ key: "task-bar@qol" })).toBeDefined();
    await ui.unmount();
  }
});

const SEEN_MOD: Seen = { hasModule: true, isManaged: false, version: "0.9.0" };

const listedPlugin = (
  id: string,
  { scope = "user", enabled = true, isMod = true } = {},
): ListedPlugin => ({
  entry: { id, scope, enabled, version: "1.0.0" },
  hooks: isMod ? { modules: ["./register.tsx"] } : undefined,
  manifest: { description: `About ${id}`, version: "1.0.0" },
});

test("buildRows merges plugin.register: a module seen, the organization's, a --plugin-dir one", () => {
  const seenPlugins = new Map<string, Seen>([
    ["seen-only@qol", SEEN_MOD],
    ["required@corp", { ...SEEN_MOD, isManaged: true }],
    ["unlisted@corp", { ...SEEN_MOD, isManaged: true }],
    ["dev@inline", SEEN_MOD],
    ["skills@qol", { ...SEEN_MOD, hasModule: false }],
    ["stray@qol", SEEN_MOD],
  ]);
  const rows = buildRows(
    [
      listedPlugin("seen-only@qol", { isMod: false }),
      listedPlugin("required@corp"),
      listedPlugin("skills@qol", { isMod: false }),
      listedPlugin("plain@qol"),
    ],
    seenPlugins,
    { "plain@qol": false },
  );

  expect(rows.map((row) => [row.id, row.lock, row.scope, row.isOn])).toEqual([
    ["dev@inline", "session", "session", true],
    ["plain@qol", null, "user", false],
    ["required@corp", "managed", "user", true],
    ["seen-only@qol", null, "user", true],
    ["unlisted@corp", "managed", null, true],
  ]);
  expect(rows.find((row) => row.id === "plain@qol")).toEqual({
    id: "plain@qol",
    name: "plain",
    marketplace: "qol",
    version: "1.0.0",
    description: "About plain@qol",
    scope: "user",
    isOn: false,
    lock: null,
    problem: null,
  });
});

test("buildRows drops bad ids and cleans display text", () => {
  const rows = buildRows(
    [
      {
        entry: { id: "bad id@qol" },
        hooks: { modules: ["x"] },
        manifest: undefined,
      },
      {
        entry: { id: "ok@qol", scope: "user", enabled: true },
        hooks: { modules: ["x"] },
        manifest: { description: "line one\n\u001b[31mred\u0007" },
      },
    ],
    new Map(),
    {},
  );

  expect(rows.map((row) => row.id)).toEqual(["ok@qol"]);
  expect(rows[0]?.description).toBe("line one [31mred");
});

test("a switch runs the exact argv in the install scope and shows the reload line", async ($, on) => {
  const engine = world(on, { plugins: [QOL, FRESH] });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  expect(await ui.find({ key: "reload" })).toBeUndefined();
  await ui.press({ key: "task-bar@qol" });
  await ui.press({ key: "fresh-start@qol" });

  expect(engine.runs.slice(1)).toEqual([
    [
      "claude",
      "plugin",
      "disable",
      "task-bar@qol",
      "--scope",
      "user",
      "--json",
    ],
    [
      "claude",
      "plugin",
      "enable",
      "fresh-start@qol",
      "--scope",
      "project",
      "--json",
    ],
  ]);
  expect((await ui.find({ key: "task-bar@qol" }))?.text).toBe("○ off");
  expect((await ui.find({ key: "fresh-start@qol" }))?.text).toBe("● on");
  expect(await texts(ui)).toContain("Changes apply to new chats.");
  expect((await ui.find({ key: "reload" }))?.text).toBe("Reload now");
  await ui.unmount();
});

test("a refused switch keeps the state and says why", async ($, on) => {
  const engine = world(on, {
    plugins: [QOL],
    refuse: { "task-bar@qol": "not allowed" },
  });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.press({ key: "task-bar@qol" });

  expect(engine.toasts).toEqual(["Could not switch task-bar: not allowed"]);
  expect((await ui.find({ key: "task-bar@qol" }))?.text).toBe("● on");
  expect(await ui.find({ key: "reload" })).toBeUndefined();
  await ui.unmount();
});

test("a bad id or an unknown scope never reaches a process call", async ($, on) => {
  const odd = {
    entry: {
      id: "evil; rm -rf ~@qol",
      scope: "user",
      enabled: true,
      installPath: "/cache/evil",
    },
    files: { "/cache/evil/hooks/hooks.json": MOD_HOOKS },
  };
  const strange = installed("strange@qol", { scope: "galaxy" });
  const engine = world(on, { plugins: [odd, strange] });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  // The bad id is not listed at all.
  expect((await texts(ui)).some((text) => text.includes("evil"))).toBe(false);
  await ui.press({ key: "strange@qol" });

  expect(engine.runs).toEqual([["claude", "plugin", "list", "--json"]]);
  expect(engine.toasts).toEqual([
    "Could not switch strange: it cannot be switched from here",
  ]);
  await ui.unmount();
});

test("two quick presses switch once", async ($, on) => {
  const engine = world(on, { plugins: [QOL] });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  await Promise.all([
    ui.press({ key: "task-bar@qol" }),
    ui.press({ key: "task-bar@qol" }),
  ]);

  expect(engine.runs.slice(1)).toHaveLength(1);
  await ui.unmount();
});

test("Reload now runs reload-plugins and hides the line", async ($, on) => {
  const engine = world(on, { plugins: [QOL] });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "task-bar@qol" });

  await ui.press({ key: "reload" });

  expect(engine.commands).toEqual(["reload-plugins"]);
  expect(await ui.find({ key: "reload" })).toBeUndefined();
  await ui.unmount();
});

test("a failed reload keeps the line and says what to run", async ($, on) => {
  const engine = world(on, { plugins: [QOL], reloadFails: true });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "task-bar@qol" });

  await ui.press({ key: "reload" });

  expect(engine.toasts).toEqual(["Could not reload. Run /reload-plugins."]);
  expect(await ui.find({ key: "reload" })).toBeDefined();
  await ui.unmount();
});

test("a CLI failure shows the error row and Try again lists again", async ($, on) => {
  const engine = world(on, { plugins: [QOL], listFails: "plugin list broke" });
  await openPane($);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await texts(ui)).toContain("Could not list mods: plugin list broke");
    expect((await ui.find({ key: "retry" }))?.text).toBe("Try again");
    await ui.unmount();
  }

  engine.setListFails(undefined);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  await ui.press({ key: "retry" });

  expect(await ui.find({ key: "retry" })).toBeUndefined();
  expect((await ui.find({ key: "task-bar@qol" }))?.text).toBe("● on");
  await ui.unmount();
});

test("no mods says so", async ($, on) => {
  world(on, { plugins: [SKILLS] });
  await openPane($);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await texts(ui)).toContain("No mods installed.");
    await ui.unmount();
  }
});

test("Save as set stores the ids that are on, locked ones left out", async ($, on) => {
  const engine = world(on, { plugins: [QOL, FRESH, SELF] });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  await ui.press({ key: "save-set" });
  await ui.input({ key: "set-name", text: "  recording " });

  expect(engine.store.get("sets")).toEqual([
    { name: "recording", on: ["task-bar@qol"] },
  ]);
  expect(await texts(ui)).toContain("recording");
  expect(await ui.find({ key: "apply:recording" })).toBeDefined();
  expect(await ui.find({ key: "set-name" })).toBeUndefined();
  await ui.unmount();
});

test("a bad set name is refused with a hint", async ($, on) => {
  const engine = world(on, { plugins: [QOL] });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  await ui.press({ key: "save-set" });
  await ui.input({ key: "set-name", text: "rec/ording" });

  expect(engine.store.has("sets")).toBe(false);
  expect(await texts(ui)).toContain(
    "Use 1 to 30 letters, digits, spaces or dashes.",
  );
  await ui.unmount();
});

test("the same name replaces only when submitted again", async ($, on) => {
  const engine = world(on, {
    plugins: [QOL, FRESH],
    sets: [{ name: "recording", on: ["fresh-start@qol"] }],
  });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  await ui.press({ key: "save-set" });
  await ui.input({ key: "set-name", text: "recording" });

  expect(await texts(ui)).toContain('Press again to replace "recording".');
  expect(engine.store.get("sets")).toEqual([
    { name: "recording", on: ["fresh-start@qol"] },
  ]);

  await ui.input({ key: "set-name", text: "recording" });

  expect(engine.store.get("sets")).toEqual([
    { name: "recording", on: ["task-bar@qol"] },
  ]);
  await ui.unmount();
});

test("Apply switches only the differences and names ids no longer installed", async ($, on) => {
  const extra = installed("cache-meter@qol", { enabled: true });
  const engine = world(on, {
    plugins: [QOL, FRESH, extra],
    // task-bar on (already), fresh-start on (differs), cache-meter off (differs).
    sets: [
      {
        name: "recording",
        on: ["task-bar@qol", "fresh-start@qol", "gone@qol"],
      },
    ],
  });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  await ui.press({ key: "apply:recording" });

  expect(engine.runs.slice(1)).toEqual([
    [
      "claude",
      "plugin",
      "disable",
      "cache-meter@qol",
      "--scope",
      "user",
      "--json",
    ],
    [
      "claude",
      "plugin",
      "enable",
      "fresh-start@qol",
      "--scope",
      "project",
      "--json",
    ],
  ]);
  expect(engine.toasts).toEqual(["Skipped, not installed any more: gone@qol"]);
  expect(await ui.find({ key: "reload" })).toBeDefined();
  await ui.unmount();
});

test("Delete removes a set", async ($, on) => {
  const engine = world(on, {
    plugins: [QOL],
    sets: [
      { name: "recording", on: [] },
      { name: "focus", on: ["task-bar@qol"] },
    ],
  });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.press({ key: "delete:recording" });

  expect(engine.store.get("sets")).toEqual([
    { name: "focus", on: ["task-bar@qol"] },
  ]);
  expect(await ui.find({ key: "apply:recording" })).toBeUndefined();
  await ui.unmount();
});

test("stored sets of the wrong shape are ignored", async ($, on) => {
  world(on, {
    plugins: [QOL],
    sets: [{ name: "x/y", on: [] }, "junk", { name: "ok", on: [1] }],
  });
  await openPane($);
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });

  expect(await texts(ui)).toContain("No sets saved yet.");
  await ui.unmount();
});

test("the pane shows the loading row while the CLI lists", async ($, on) => {
  let release = () => {};
  const listWaits = new Promise<void>((resolve) => {
    release = resolve;
  });
  world(on, { plugins: [QOL], listWaits });
  await $.command.run(MODS);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await texts(ui)).toEqual(["Looking for mods…"]);
    await ui.unmount();
  }

  release();
});
