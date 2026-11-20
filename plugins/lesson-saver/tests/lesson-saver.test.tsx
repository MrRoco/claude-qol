import { expect, mock, test } from "claude-code/testing";
import type { Engine, Mounted } from "claude-code/testing";
import type { On } from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;
type Surface = (typeof SURFACES)[number];

const ROOT = "/work/project";
const HOME = "/home/tester";
const PROJECT_FILE = `${ROOT}/CLAUDE.md`;
const GLOBAL_FILE = `${HOME}/.claude/CLAUDE.md`;
// 20-11-2026 14:32 in local time, as the date note reads it.
const START = new Date(2026, 10, 20, 14, 32, 10).getTime();
const DATE = "20-11-2026";

const RULE = "Run the linter before every commit";
const ANSWER = "I committed the change without running the linter.";
const PROMPT = "No, always run the linter before you commit.";

const BAND = {
  plugin: "lesson-saver",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

const verdict = (rule: string, scope: "project" | "global" = "project") =>
  JSON.stringify({ lasting: true, rule, scope });

type ModelCall = {
  model: string;
  prompt: string;
  system: string | undefined;
  maxTokens: number | undefined;
  timeoutMs: number | undefined;
};

type World = {
  files: Map<string, string>;
  writes: { path: string; text: string }[];
  // Every path the mod checked, read or wrote.
  touched: string[];
  toasts: string[];
  models: ModelCall[];
  // Order of the prompt entering and the side request starting.
  calls: string[];
  advance: (ms: number) => Promise<void>;
  // What the next side request answers: text, or no answer at all.
  reply: string | null;
  // How long the next side request takes on the held clock.
  replyDelayMs: number;
};

type WorldOptions = {
  files?: Record<string, string>;
  home?: string | null;
  root?: string;
  failWrite?: string;
  isPromptDropped?: boolean;
  // How long the write takes on the held clock.
  writeDelayMs?: number;
  // Writes are recorded but the files stay as they were (changed back elsewhere).
  isWriteLost?: boolean;
  // Files that exist but cannot be read.
  unreadable?: string[];
  // What the chain beneath settles the prompt to (another mod masking it).
  enteredText?: string;
};

/**
 * Stands in for the engine beneath the mod: the file system in memory, the
 * side request answering what the test sets, the clock held.
 */
const world = (on: On, options: WorldOptions = {}): World => {
  const clock = mock.clock(on, { now: START });

  if (options.home !== null) {
    mock.env(on, { HOME: options.home ?? HOME });
  } else {
    mock.env(on, {});
  }

  const result: World = {
    files: new Map(Object.entries(options.files ?? {})),
    writes: [],
    touched: [],
    toasts: [],
    models: [],
    calls: [],
    advance: (ms) => clock.advance(ms),
    reply: verdict(RULE),
    replyDelayMs: 0,
  };
  const unreadable = new Set(options.unreadable ?? []);

  on("session.root", () => ({ value: options.root ?? ROOT }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("prompt.submit", (_, e) => {
    result.calls.push("entered");

    return options.isPromptDropped === true
      ? { drop: "busy" }
      : { text: options.enteredText ?? e.text };
  });
  on("model.complete", async (_, e) => {
    result.calls.push("model");
    result.models.push({
      model: e.model,
      prompt: e.prompt,
      system: e.system,
      maxTokens: e.maxTokens,
      timeoutMs: e.timeoutMs,
    });
    // Taken as the request starts, so a later change is the next request's.
    const reply = result.reply;
    const delay = result.replyDelayMs;
    const usage = {
      input_tokens: 40,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    if (delay > 0) {
      await clock.sleep(delay);
    }

    return {
      value:
        reply === null
          ? { isAnswered: false as const, reason: "aborted" as const, usage }
          : { isAnswered: true as const, text: reply, usage },
    };
  });
  on("fs.exists", (_, e) => {
    result.touched.push(e.path);

    return { value: result.files.has(e.path) || unreadable.has(e.path) };
  });
  on("fs.read", (_, e) => {
    result.touched.push(e.path);
    if (unreadable.has(e.path)) {
      return { deny: "EACCES" };
    }

    const text = result.files.get(e.path);

    return text === undefined ? { deny: "ENOENT" } : { value: text };
  });
  on("fs.write", async (_, e) => {
    result.touched.push(e.path);

    if (options.failWrite !== undefined) {
      return { deny: options.failWrite };
    }

    if (options.writeDelayMs !== undefined) {
      await clock.sleep(options.writeDelayMs);
    }

    result.writes.push({ path: e.path, text: e.text });

    if (options.isWriteLost !== true) {
      result.files.set(e.path, e.text);
    }

    return { value: undefined };
  });
  on("ui.toast", (_, e) => {
    result.toasts.push(e.text);

    return { value: undefined };
  });

  return result;
};

const completeTurn = (
  $: Engine,
  answer: string,
  extra: { agentId?: string } = {},
) =>
  $.turn.complete({
    answer,
    durationMs: 10,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
    ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
  });

/** Types a prompt as the person would; the side request runs on the clock. */
const typePrompt = async ($: Engine, engine: World, text = PROMPT) => {
  const result = await $.prompt.submit({
    text,
    wait: false,
    origin: { kind: "composer" },
  });
  await engine.advance(0);

  return result;
};

/** An answer, then a correcting prompt: the row offers the lesson. */
const toLesson = async ($: Engine, engine: World) => {
  await completeTurn($, ANSWER);
  await typePrompt($, engine);
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

const press = async ($: Engine, key: string) => {
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key });
  });
};

const expectNoRow = async ($: Engine) => {
  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }
};

const buttonKeys = async (ui: Mounted<Surface, "AbovePrompt">) =>
  (await ui.findAll({ type: "Button" })).map((one) => one.key);

const HEADER = "✎ New lesson";

/** The text line right under the card's header: the rule on offer. */
const shownRule = async (ui: Mounted<Surface, "AbovePrompt">) => {
  const texts = await ui.findAll({ type: "Text" });
  const header = texts.findIndex((one) => one.text === HEADER);

  return header === -1 ? undefined : texts[header + 1]?.text;
};

/** Every state draws one round card in the theme accent, header first. */
const expectCard = async (ui: Mounted<Surface, "AbovePrompt">) => {
  expect(await ui.drawn()).toMatchObject({
    type: "Box",
    props: {
      flexDirection: "column",
      width: BAND.props.bodyColumns,
      borderStyle: "round",
      borderColor: "claude",
    },
  });
  // No background colour anywhere: terminal backgrounds drew patchy.
  expect(JSON.stringify(await ui.drawn())).not.toContain("backgroundColor");
  const header = await ui.find({ type: "Text", text: HEADER });
  expect(header?.props.color).toBe("claude");
  expect(header?.props.weight).toBe("bold");
};

test("a typed short prompt after an answer starts one check, after the prompt entered", async ($, on) => {
  const engine = world(on);
  await completeTurn($, ANSWER);
  await typePrompt($, engine);

  expect(engine.calls).toEqual(["entered", "model"]);
  expect(engine.models.length).toBe(1);
  const call = engine.models[0];
  expect(call?.model).toBe("haiku");
  expect(call?.maxTokens).toBe(1024);
  expect(call?.timeoutMs).toBe(20000);
  expect(call?.prompt).toBe(
    `Assistant's previous answer (end):\n${ANSWER}\n\nMessage:\n${PROMPT}`,
  );
  expect(
    call?.system?.startsWith(
      "You decide whether a message corrects an AI coding assistant",
    ),
  ).toBe(true);
  expect(call?.system).toContain(
    'Reply with JSON only: {"lasting": true|false, "rule": "...", "scope": "project"|"global"}',
  );
});

test("only the last 2,000 characters of the answer are sent", async ($, on) => {
  const engine = world(on);
  const long = `${"a".repeat(500)}${"b".repeat(2000)}`;
  await completeTurn($, long);
  await typePrompt($, engine);

  expect(engine.models[0]?.prompt).toBe(
    `Assistant's previous answer (end):\n${"b".repeat(2000)}\n\nMessage:\n${PROMPT}`,
  );
});

test("prompts before any answer, long, meta, command and other-origin prompts start no check", async ($, on) => {
  const engine = world(on);

  // Before any answer; a subagent's answer does not count.
  await typePrompt($, engine);
  await completeTurn($, "subagent report", { agentId: "a1" });
  await typePrompt($, engine);
  await completeTurn($, "   ");
  await typePrompt($, engine);
  expect(engine.models.length).toBe(0);

  await completeTurn($, ANSWER);
  await typePrompt($, engine, "x".repeat(401));
  await typePrompt($, engine, "   ");
  await $.prompt.submit({
    text: PROMPT,
    wait: false,
    origin: { kind: "composer" },
    isMeta: true,
  });
  await $.prompt.submit({
    text: "/review",
    wait: false,
    origin: { kind: "composer" },
    command: { name: "review", args: "" },
  });
  await $.prompt.submit({
    text: PROMPT,
    wait: false,
    origin: { kind: "task-notification" },
  });
  await engine.advance(0);
  expect(engine.models.length).toBe(0);

  // Exactly at the limit is checked.
  await typePrompt($, engine, "x".repeat(400));
  expect(engine.models.length).toBe(1);
});

test("a dropped prompt starts no check", async ($, on) => {
  const engine = world(on, { isPromptDropped: true });
  await completeTurn($, ANSWER);
  await typePrompt($, engine);

  expect(engine.models.length).toBe(0);
});

test(
  "a custom maxLength and model are used",
  { options: { maxLength: 50, model: "sonnet" } },
  async ($, on) => {
    const engine = world(on);
    await completeTurn($, ANSWER);
    await typePrompt($, engine, "x".repeat(51));
    expect(engine.models.length).toBe(0);

    await typePrompt($, engine, "x".repeat(50));
    expect(engine.models.map((one) => one.model)).toEqual(["sonnet"]);
  },
);

test(
  "a maxLength below 40 and an unknown model fall back to 400 and haiku",
  { options: { maxLength: 10, model: "opus" } },
  async ($, on) => {
    const engine = world(on);
    await completeTurn($, ANSWER);
    await typePrompt($, engine, "x".repeat(400));

    expect(engine.models.map((one) => one.model)).toEqual(["haiku"]);
  },
);

test("lasting true shows the rule with the suggested target first", async ($, on) => {
  const engine = world(on);
  await toLesson($, engine);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      await expectCard(ui);
      expect(await shownRule(ui)).toBe(RULE);
      const rule = await ui.find({ type: "Text", text: RULE });
      expect(rule?.props.wrap).toBe("wrap");
      // Buttons sit in their own row under the rule, free to wrap.
      expect(await ui.drawn()).toMatchObject({
        children: [
          { type: "Text" },
          { type: "Text" },
          { type: "Box", props: { flexDirection: "row", flexWrap: "wrap" } },
        ],
      });
      expect(await buttonKeys(ui)).toEqual([
        "save-project",
        "save-global",
        "edit",
        "skip",
      ]);
      expect(
        (await ui.find({ type: "Button", key: "save-project" }))?.props.variant,
      ).toBe("primary");
    });
  }

  engine.reply = verdict("Write commit messages in English", "global");
  await typePrompt($, engine, "Commit messages are always in English.");

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await shownRule(ui)).toBe("Write commit messages in English");
      expect(await buttonKeys(ui)).toEqual([
        "save-global",
        "save-project",
        "edit",
        "skip",
      ]);
      expect(
        (await ui.find({ type: "Button", key: "save-global" }))?.props.variant,
      ).toBe("primary");
      expect(
        (await ui.find({ type: "Button", key: "save-project" }))?.props.variant,
      ).toBeUndefined();
    });
  }
});

test("lasting false, bad JSON, an empty rule or no answer show nothing", async ($, on) => {
  const engine = world(on);
  await completeTurn($, ANSWER);

  for (const reply of [
    JSON.stringify({ lasting: false, rule: RULE, scope: "project" }),
    "Sure, that is a lasting rule.",
    '{"lasting": true, "rule": ',
    JSON.stringify({ lasting: true, rule: "  \n ", scope: "project" }),
    JSON.stringify({ lasting: "yes", rule: RULE }),
    null,
  ]) {
    engine.reply = reply;
    await typePrompt($, engine);
    await expectNoRow($);
  }

  expect(engine.models.length).toBe(6);
});

test("JSON around other text is read; a long or multi-line rule is made one line of at most 200", async ($, on) => {
  const engine = world(on);
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
  engine.reply = `Here you go:\n${JSON.stringify({
    lasting: true,
    rule: `- ${words.slice(0, 3).join("\n")} ${words.slice(3).join(" ")}`,
    scope: "elsewhere",
  })}`;
  await toLesson($, engine);

  await onBand($, "terminal", async (ui) => {
    const rule = (await shownRule(ui)) ?? "";
    expect(rule.endsWith("…")).toBe(true);
    expect(rule.length <= 200).toBe(true);
    expect(rule.startsWith("word0 word1 word2 word3")).toBe(true);
    // Cut at a word boundary: the last word before … is whole.
    const last = rule.slice(0, -1).split(" ").pop() ?? "";
    expect(words).toContain(last);
    // An unknown scope suggests the project.
    expect(await buttonKeys(ui)).toEqual([
      "save-project",
      "save-global",
      "edit",
      "skip",
    ]);
  });
});

test("Save to project inserts the line as the last item of the section; every other byte stays", async ($, on) => {
  const before =
    "# Project\n\nIntro text.\n\n## Rules from corrections\n\n- Use tabs (added 01-10-2026)\n- Keep functions short\n  and focused (added 02-10-2026)\n\n## Later\n\n- not part of it\n";
  const engine = world(on, { files: { [PROJECT_FILE]: before } });
  await toLesson($, engine);
  await press($, "save-project");

  expect(engine.writes).toEqual([
    {
      path: PROJECT_FILE,
      text:
        "# Project\n\nIntro text.\n\n## Rules from corrections\n\n- Use tabs (added 01-10-2026)\n- Keep functions short\n  and focused (added 02-10-2026)\n" +
        `- ${RULE} (added ${DATE})\n` +
        "\n## Later\n\n- not part of it\n",
    },
  ]);
  expect(engine.toasts).toEqual(["Rule saved to the project CLAUDE.md."]);
  await expectNoRow($);
});

test("a section at the end of a file without a final newline gets the line after its last item", async ($, on) => {
  const before =
    "Intro\n\n## Rules from corrections\n\n- Use tabs (added 01-10-2026)";
  const engine = world(on, { files: { [PROJECT_FILE]: before } });
  await toLesson($, engine);
  await press($, "save-project");

  expect(engine.writes[0]?.text).toBe(`${before}\n- ${RULE} (added ${DATE})\n`);
});

test("an empty section gets the line after its heading, one blank line between", async ($, on) => {
  const before = "Intro\n\n## Rules from corrections\n\n## Next\ntext\n";
  const engine = world(on, { files: { [PROJECT_FILE]: before } });
  await toLesson($, engine);
  await press($, "save-project");

  expect(engine.writes[0]?.text).toBe(
    `Intro\n\n## Rules from corrections\n\n- ${RULE} (added ${DATE})\n\n## Next\ntext\n`,
  );
});

test("a missing section is added at the end, one blank line before it", async ($, on) => {
  // Each round saves a different rule: the one just saved is not offered again.
  const rules = [
    "Run the linter before every commit",
    "Prefer early returns over nested conditions",
    "Write commit messages in English",
    "Keep database migrations reversible",
  ];
  const cases: [string, (rule: string) => string][] = [
    [
      "# Notes\n\n- one\n",
      (rule) =>
        `# Notes\n\n- one\n\n## Rules from corrections\n\n- ${rule} (added ${DATE})\n`,
    ],
    [
      "# Notes",
      (rule) =>
        `# Notes\n\n## Rules from corrections\n\n- ${rule} (added ${DATE})\n`,
    ],
    [
      "# Notes\n\n",
      (rule) =>
        `# Notes\n\n## Rules from corrections\n\n- ${rule} (added ${DATE})\n`,
    ],
    // A heading inside a code block is not the section.
    [
      "```md\n## Rules from corrections\n```\n",
      (rule) =>
        `\`\`\`md\n## Rules from corrections\n\`\`\`\n\n## Rules from corrections\n\n- ${rule} (added ${DATE})\n`,
    ],
  ];
  const engine = world(on);
  await completeTurn($, ANSWER);

  for (const [index, [before, after]] of cases.entries()) {
    const rule = rules[index] ?? RULE;
    engine.files.set(PROJECT_FILE, before);
    engine.writes.length = 0;
    engine.reply = verdict(rule);
    await typePrompt($, engine);
    await press($, "save-project");
    expect(engine.writes).toEqual([{ path: PROJECT_FILE, text: after(rule) }]);
  }
});

test("a file with Windows line breaks keeps them", async ($, on) => {
  const before =
    "# Notes\r\n\r\n## Rules from corrections\r\n\r\n- Use tabs\r\n";
  const engine = world(on, { files: { [PROJECT_FILE]: before } });
  await toLesson($, engine);
  await press($, "save-project");

  expect(engine.writes[0]?.text).toBe(`${before}- ${RULE} (added ${DATE})\r\n`);
});

test("a missing project CLAUDE.md is created", async ($, on) => {
  const engine = world(on);
  await toLesson($, engine);
  await press($, "save-project");

  expect(engine.writes).toEqual([
    {
      path: PROJECT_FILE,
      text: `## Rules from corrections\n\n- ${RULE} (added ${DATE})\n`,
    },
  ]);
});

test("Save globally writes <HOME>/.claude/CLAUDE.md only", async ($, on) => {
  const engine = world(on, {
    files: { [PROJECT_FILE]: "# Project\n", [GLOBAL_FILE]: "# Me\n" },
  });
  await toLesson($, engine);
  await press($, "save-global");

  expect(engine.writes).toEqual([
    {
      path: GLOBAL_FILE,
      text: `# Me\n\n## Rules from corrections\n\n- ${RULE} (added ${DATE})\n`,
    },
  ]);
  expect(engine.toasts).toEqual(["Rule saved to your global CLAUDE.md."]);
  expect(engine.files.get(PROJECT_FILE)).toBe("# Project\n");
  // Nothing but the two files is ever checked, read or written.
  expect([...new Set(engine.touched)].sort()).toEqual(
    [GLOBAL_FILE, PROJECT_FILE].sort(),
  );
});

test("no HOME or no root: nothing is written and the person is told", async ($, on) => {
  const engine = world(on, { home: null, root: "" });
  await toLesson($, engine);
  await press($, "save-global");
  await press($, "save-project");

  expect(engine.writes).toEqual([]);
  expect(engine.toasts).toEqual([
    "Could not find where to save this rule.",
    "Could not find where to save this rule.",
  ]);
  // The lesson stays on offer.
  await onBand($, "terminal", async (ui) => {
    expect(await shownRule(ui)).toBe(`${RULE}`);
  });
});

test("a near-duplicate of a saved rule is not offered", async ($, on) => {
  const engine = world(on, {
    files: {
      [GLOBAL_FILE]:
        "## Rules from corrections\n\n- Run the linter before every single commit. (added 01-10-2026)\n",
    },
  });
  await toLesson($, engine);

  expect(engine.models.length).toBe(1);
  await expectNoRow($);

  // A different rule is offered.
  engine.reply = verdict("Prefer early returns over nested conditions");
  await typePrompt($, engine);
  await onBand($, "terminal", async (ui) => {
    expect(await shownRule(ui)).toBe(
      "Prefer early returns over nested conditions",
    );
  });
});

test("Save on a near-duplicate writes nothing, says so and clears the lesson", async ($, on) => {
  const engine = world(on);
  await toLesson($, engine);
  // Saved elsewhere meanwhile, in other words.
  engine.files.set(
    PROJECT_FILE,
    "# P\n\n## Rules from corrections\n\n- Always run the linter before every commit! (added 19-11-2026)\n",
  );
  await press($, "save-project");

  expect(engine.writes).toEqual([]);
  expect(engine.toasts).toEqual([
    "A rule like this is already in the project CLAUDE.md.",
  ]);
  await expectNoRow($);
});

test("Edit shows the rule in a field; Enter keeps the edit, which is what is saved", async ($, on) => {
  const engine = world(on);
  await toLesson($, engine);
  await press($, "edit");

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      const field = await ui.find({ type: "Input", key: "rule" });
      expect(field?.props.value).toBe(RULE);
      expect(field?.props.rows).toBe(2);
      expect(field?.props.autoFocus).toBe(true);
      expect(await buttonKeys(ui)).toEqual(["cancel-edit"]);
      await expectCard(ui);
    });
  }

  await onBand($, "desktop", async (ui) => {
    await ui.input({
      key: "rule",
      text: "Run the linter and the tests\nbefore every commit",
    });
  });

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await shownRule(ui)).toBe(
        "Run the linter and the tests before every commit",
      );
    });
  }

  await press($, "save-project");
  expect(engine.writes[0]?.text).toBe(
    `## Rules from corrections\n\n- Run the linter and the tests before every commit (added ${DATE})\n`,
  );
});

test("Cancel edit and an emptied field keep the drafted rule", async ($, on) => {
  const engine = world(on);
  await toLesson($, engine);
  await press($, "edit");
  await press($, "cancel-edit");

  await onBand($, "terminal", async (ui) => {
    expect(await shownRule(ui)).toBe(`${RULE}`);
  });

  await press($, "edit");
  await onBand($, "terminal", async (ui) => {
    await ui.input({ key: "rule", text: "   " });
  });
  await onBand($, "terminal", async (ui) => {
    expect(await shownRule(ui)).toBe(`${RULE}`);
  });
});

test("a newer check does not replace the rule while it is being edited", async ($, on) => {
  const engine = world(on);
  await toLesson($, engine);
  await press($, "edit");
  engine.reply = verdict("Prefer early returns over nested conditions");
  await typePrompt($, engine);

  await onBand($, "terminal", async (ui) => {
    expect((await ui.find({ type: "Input", key: "rule" }))?.props.value).toBe(
      RULE,
    );
  });
});

test("Skip clears the row and writes nothing", async ($, on) => {
  const engine = world(on);
  await toLesson($, engine);
  await press($, "skip");

  expect(engine.writes).toEqual([]);
  await expectNoRow($);
});

test("while saving the row shows Saving without buttons", async ($, on) => {
  const engine = world(on, { writeDelayMs: 1000 });
  await toLesson($, engine);
  // The press settles while the write still sleeps on the held clock.
  await press($, "save-project");
  expect(engine.writes).toEqual([]);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      await expectCard(ui);
      expect(await shownRule(ui)).toBe("Saving…");
      expect(await ui.findAll({ type: "Button" })).toHaveLength(0);
    });
  }

  // The write ends: saved, and the row is gone.
  await engine.advance(1000);
  expect(engine.writes.length).toBe(1);
  expect(engine.toasts).toEqual(["Rule saved to the project CLAUDE.md."]);
  await expectNoRow($);
});

test("a write error keeps the lesson and tells the person", async ($, on) => {
  const engine = world(on, { failWrite: "disk full" });
  await toLesson($, engine);
  await press($, "save-project");

  expect(engine.writes).toEqual([]);
  expect(engine.toasts.length).toBe(1);
  expect(engine.toasts[0]?.startsWith("Could not save the rule: ")).toBe(true);
  expect(engine.toasts[0]).toContain("disk full");

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await shownRule(ui)).toBe(`${RULE}`);
      expect(await buttonKeys(ui)).toContain("save-project");
    });
  }
});

test("/clear drops the lesson and the remembered answer", async ($, on) => {
  const engine = world(on);
  await toLesson($, engine);
  await $.session.end({
    reason: "clear",
    sessionId: "s1",
    resume: {} as never,
  });

  await expectNoRow($);
  await typePrompt($, engine);
  expect(engine.models.length).toBe(1);
});

test("a check still running at /clear shows nothing afterwards", async ($, on) => {
  const engine = world(on);
  await completeTurn($, ANSWER);
  // The prompt enters; the side request is still on the clock at /clear.
  await $.prompt.submit({
    text: PROMPT,
    wait: false,
    origin: { kind: "composer" },
  });
  await $.session.end({
    reason: "clear",
    sessionId: "s1",
    resume: {} as never,
  });
  await engine.advance(0);

  await expectNoRow($);
});

test("a survey above the prompt keeps the row away", async ($, on) => {
  const engine = world(on);
  await toLesson($, engine);
  const ui = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
    surface: "terminal",
  });
  expect(await ui.keepsBeneath()).toBe(true);
  await ui.unmount();
});

test("hooks pass events through unchanged", async ($, on) => {
  const engine = world(on);

  expect(await completeTurn($, ANSWER)).toEqual({ text: ANSWER });
  expect(await typePrompt($, engine)).toEqual({ text: PROMPT });
  expect(
    await $.prompt.submit({
      text: "  spaced  ",
      wait: false,
      origin: { kind: "task-notification" },
    }),
  ).toEqual({ text: "  spaced  " });
  expect(
    await $.session.end({
      reason: "clear",
      sessionId: "s1",
      resume: {} as never,
    }),
  ).toEqual({ sessionId: "s1" });
  expect(
    await $.session.end({
      reason: "other",
      sessionId: "s2",
      resume: {} as never,
    }),
  ).toEqual({ sessionId: "s2" });
});

test("an older check answering late does not replace a newer lesson", async ($, on) => {
  const engine = world(on);
  await completeTurn($, ANSWER);
  engine.reply = verdict(RULE);
  engine.replyDelayMs = 1000;
  await typePrompt($, engine);
  engine.reply = verdict("Prefer early returns over nested conditions");
  engine.replyDelayMs = 0;
  await typePrompt($, engine, "Use early returns, not nested ifs.");
  await engine.advance(1000);

  expect(engine.models.length).toBe(2);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await shownRule(ui)).toBe(
        "Prefer early returns over nested conditions",
      );
    });
  }
});

test("a near-duplicate of the rule just saved is not offered, even unseen in the file", async ($, on) => {
  const engine = world(on, { isWriteLost: true });
  await toLesson($, engine);
  await press($, "save-project");
  expect(engine.writes.length).toBe(1);

  engine.reply = verdict("Always run the linter before every commit");
  await typePrompt($, engine);

  await expectNoRow($);
});

test("an existing file that cannot be read is never written", async ($, on) => {
  const engine = world(on, { unreadable: [PROJECT_FILE] });
  await toLesson($, engine);
  await press($, "save-project");

  expect(engine.writes).toEqual([]);
  expect(engine.toasts.length).toBe(1);
  expect(engine.toasts[0]?.startsWith("Could not save the rule: ")).toBe(true);
  expect(engine.toasts[0]).toContain("EACCES");
  await onBand($, "terminal", async (ui) => {
    expect(await shownRule(ui)).toBe(`${RULE}`);
  });
});

test("the side request gets the prompt as the chain settled it", async ($, on) => {
  const engine = world(on, {
    enteredText: "Never commit to the [masked] branch.",
  });
  await toLesson($, engine);

  expect(engine.models[0]?.prompt).toBe(
    `Assistant's previous answer (end):\n${ANSWER}\n\nMessage:\nNever commit to the [masked] branch.`,
  );
});

test("the inserted line takes the line break of the line it follows", async ($, on) => {
  // Windows breaks above the section, Unix breaks inside it.
  const before =
    "# Notes\r\n\r\n## Rules from corrections\n\n- Use tabs\n\n## Next\r\n";
  const engine = world(on, { files: { [PROJECT_FILE]: before } });
  await toLesson($, engine);
  await press($, "save-project");

  expect(engine.writes[0]?.text).toBe(
    `# Notes\r\n\r\n## Rules from corrections\n\n- Use tabs\n- ${RULE} (added ${DATE})\n\n## Next\r\n`,
  );
});

test("code blocks and thematic breaks in the section are no list items", async ($, on) => {
  const before =
    "## Rules from corrections\n\n- Use tabs\n\n```\n- run the linter before every commit\n## not a heading\n```\n\n* * *\n\nTrailing note.\n";
  const engine = world(on, { files: { [PROJECT_FILE]: before } });
  // The fenced line looks like the rule, but is not a saved rule.
  await toLesson($, engine);
  await press($, "save-project");

  expect(engine.writes[0]?.text).toBe(
    `## Rules from corrections\n\n- Use tabs\n- ${RULE} (added ${DATE})\n\n\`\`\`\n- run the linter before every commit\n## not a heading\n\`\`\`\n\n* * *\n\nTrailing note.\n`,
  );
});
