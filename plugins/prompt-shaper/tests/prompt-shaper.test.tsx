import { expect, test } from "claude-code/testing";
import type { Engine, Mounted } from "claude-code/testing";
import type { On } from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;
type Surface = (typeof SURFACES)[number];

const ROOT = "/work/project";
// Long enough to be caught at the default of 400 characters.
const LONG = `Build the CSV importer for the orders table. ${"Keep it simple. ".repeat(40)}`;
const BRIEF =
  "## Task\nBuild the CSV importer.\n\n## Done when\nOrders import.";
// The brief as it lands in the box: with the `>>` marker, so sending it passes.
const MARKED = `>> ${BRIEF}`;
const DROP = "prompt-shaper is reading your prompt.";
const READY = "Brief ready in the prompt box. Edit and send it.";
const FAILED = "Could not shape the prompt; your text is back in the box.";
const QUESTIONS_START =
  "You review a prompt someone wants to send to a coding assistant.";
const BRIEF_START = "Rewrite the prompt into a brief for a coding assistant";
const HINT =
  "Answer in the prompt box and press Enter. Start with >> to send Claude a message instead.";
const noted = (number: number, total: number) =>
  ({ drop: `prompt-shaper noted answer ${number} of ${total}.` }) as const;

const BAND = {
  plugin: "prompt-shaper",
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

const SHAPE = {
  command: "shape",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 120 },
} as const;

const USAGE = {
  input_tokens: 40,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

type Request = {
  model: string;
  system: string | undefined;
  prompt: string;
  maxTokens: number | undefined;
  timeoutMs: number | undefined;
};

type World = {
  requests: Request[];
  entered: string[];
  filled: { text: string; mode: string | undefined }[];
  toasts: string[];
  commands: string[];
  // Replies of the side requests, in order: a text, or null for not answered.
  replies: (string | null)[];
  // While set, each request waits for `release`.
  isHolding: boolean;
  release: () => Promise<void>;
  // What the prompt box holds when the mod reads it.
  box: string;
  isFillRefused: boolean;
  // While set, a prompt the mod sends itself is dropped beneath it.
  isSendRefused: boolean;
  // While set, a prompt the mod sends itself fails beneath it.
  isSendThrowing: boolean;
};

// The test runtime has a timer; the hooks' typings (es2023 only) name none.
const { setTimeout: later } = globalThis as unknown as {
  setTimeout: (run: () => void, ms: number) => unknown;
};

/**
 * Lets the run's unawaited requests and fills finish: a run started by a
 * prompt goes on after `prompt.submit` has answered.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) {
    await new Promise<void>((resolve) => later(resolve, 0));
  }
};

/** Stands in for the engine beneath the mod and records what it asked. */
const world = (on: On): World => {
  const waiting: (() => void)[] = [];
  const result: World = {
    requests: [],
    entered: [],
    filled: [],
    toasts: [],
    commands: [],
    replies: [],
    isHolding: false,
    release: async () => {
      waiting.shift()?.();
      await settle();
    },
    box: "",
    isFillRefused: false,
    isSendRefused: false,
    isSendThrowing: false,
  };

  on("command.register", (_, e) => {
    result.commands.push(e.name);

    return { value: { command: e.name } };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.root", () => ({ value: ROOT }));
  on("clock.sleep", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.toast", (_, e) => {
    result.toasts.push(e.text);

    return { value: undefined };
  });
  on("prompt.submit", (_, e) => {
    if (result.isSendThrowing && e.origin.kind === "plugin") {
      throw new Error("send failed");
    }

    if (result.isSendRefused && e.origin.kind === "plugin") {
      return { drop: "refused" };
    }

    result.entered.push(e.text);

    return { text: e.text };
  });
  on("prompt.read", () => ({
    value: { text: result.box, cursor: result.box.length },
  }));
  on("prompt.fill", (_, e) => {
    if (result.isFillRefused) {
      return { isFilled: false, refusal: "no_composer" as const };
    }

    result.filled.push({ text: e.text, mode: e.mode });

    return { isFilled: true };
  });
  on("command.run", (_, e) => ({ text: `ran ${e.command}` }));
  on("model.complete", async (_, e) => {
    result.requests.push({
      model: e.model,
      system: e.system,
      prompt: e.prompt,
      maxTokens: e.maxTokens,
      timeoutMs: e.timeoutMs,
    });

    if (result.isHolding) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }

    const reply = result.replies.shift();

    return {
      value:
        typeof reply === "string"
          ? { isAnswered: true as const, text: reply, usage: USAGE }
          : {
              isAnswered: false as const,
              reason: "aborted" as const,
              usage: USAGE,
            },
    };
  });

  return result;
};

const submit = ($: Engine, text: string, extra: Record<string, unknown> = {}) =>
  $.prompt.submit({
    text,
    wait: false,
    origin: { kind: "composer" },
    ...extra,
  } as never);

/** Submits a long typed prompt and lets the run's requests answer. */
const catchLong = async ($: Engine, text = LONG) => {
  const result = await submit($, text);
  await settle();

  return result;
};

/** Mounts the row on the surface, runs the body, unmounts. */
const onBand = async (
  $: Engine,
  surface: Surface,
  body: (ui: Mounted<Surface, "AbovePrompt">) => Promise<void>,
) => {
  const ui = await $.ui.mount({ ...BAND, surface });
  await body(ui);
  await ui.unmount();
};

const rowText = async (
  $: Engine,
  surface: Surface,
): Promise<string | undefined> => {
  let text: string | undefined;
  await onBand($, surface, async (ui) => {
    text = (await ui.find({ type: "Text", text: /◇/ }))?.text;
  });

  return text;
};

const isRowEmpty = async ($: Engine, surface: Surface): Promise<boolean> => {
  let isEmpty = false;
  await onBand($, surface, async (ui) => {
    isEmpty = await ui.keepsBeneath();
  });

  return isEmpty;
};

test("a typed prompt of 400+ characters is held and the row shows", async ($, on) => {
  const engine = world(on);
  engine.isHolding = true;

  expect(await catchLong($)).toEqual({ drop: DROP });
  expect(engine.entered).toEqual([]);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      const lead = await ui.find({ type: "Text", text: /◇/ });
      expect(lead?.text).toBe("◇ prompt-shaper · reading your prompt…");
      expect(lead?.props.color).toBe("claude");
      expect(await ui.find({ type: "Button", key: "cancel" })).toBeDefined();
    });
  }

  // The question request: the folder name and the prompt, nothing else.
  expect(engine.requests.length).toBe(1);
  const request = engine.requests[0];
  expect(request?.model).toBe("haiku");
  expect(request?.maxTokens).toBe(2048);
  expect(request?.timeoutMs).toBe(30000);
  expect(request?.system?.startsWith(QUESTIONS_START)).toBe(true);
  expect(request?.system).toContain(
    'Reply with JSON only: {"questions": ["..."]}',
  );
  expect(request?.prompt).toBe(`Project folder: project\n\nPrompt:\n${LONG}`);
});

test("shorter, queued, meta, slash, attachment and other origins pass unchanged", async ($, on) => {
  const engine = world(on);
  const short = "y".repeat(399);
  const cases: [string, Record<string, unknown>][] = [
    [short, {}],
    [`  ${short}  `, {}],
    [LONG, { turnId: "t1" }],
    [LONG, { isMeta: true }],
    [LONG, { command: { name: "review", args: "x" } }],
    [LONG, { attachments: [{ type: "image", mediaType: "image/png" }] }],
    [LONG, { origin: { kind: "task-notification" } }],
    [LONG, { origin: { kind: "sdk" } }],
    [LONG, { origin: { kind: "plugin", name: "other" } }],
  ];

  for (const [text, extra] of cases) {
    const result = await submit($, text, extra);
    expect(result.drop).toBeUndefined();
    expect(result.text).toBe(text);
  }

  await settle();
  expect(engine.requests).toEqual([]);
  expect(await isRowEmpty($, "terminal")).toBe(true);
});

test("a >> prompt passes with the marker removed, however long", async ($, on) => {
  const engine = world(on);

  expect((await submit($, ">> fix the typo")).text).toBe("fix the typo");
  expect((await submit($, ">>fix it")).text).toBe("fix it");
  expect((await submit($, ">>  two spaces")).text).toBe(" two spaces");
  expect((await submit($, `>> ${LONG}`)).text).toBe(LONG);
  // Not typed: left alone.
  expect(
    (await submit($, ">> note", { origin: { kind: "task-notification" } }))
      .text,
  ).toBe(">> note");

  await settle();
  expect(engine.requests).toEqual([]);
  expect(engine.entered).toEqual([
    "fix the typo",
    "fix it",
    " two spaces",
    LONG,
    ">> note",
  ]);
});

test("three questions: answer, skip, answer; the brief gets two Q/A pairs", async ($, on) => {
  const engine = world(on);

  for (const surface of SURFACES) {
    engine.requests.length = 0;
    engine.filled.length = 0;
    engine.toasts.length = 0;
    engine.replies.push(
      '{"questions": ["Which database?", "Which delimiter?", "Who runs it?"]}',
      BRIEF,
    );

    expect(await catchLong($)).toEqual({ drop: DROP });

    await onBand($, surface, async (ui) => {
      const lead = await ui.find({ type: "Text", text: /◇/ });
      expect(lead?.text).toBe("◇ prompt-shaper · question 1 of 3");
      expect(lead?.props.color).toBe("claude");
      const question = await ui.find({ type: "Text", text: "Which database?" });
      expect(question?.text).toBe("Which database?");
      expect(question?.props.bold).toBe(true);
      // No field of its own: the answer is typed in the prompt box.
      expect(await ui.find({ type: "Input" })).toBeUndefined();
      expect((await ui.find({ type: "Text", text: HINT }))?.text).toBe(HINT);
      expect(await ui.find({ type: "Button", key: "skip" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "skip-all" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "cancel" })).toBeDefined();
    });
    expect(await submit($, "Postgres ")).toEqual(noted(1, 3));

    expect(await rowText($, surface)).toBe(
      "◇ prompt-shaper · question 2 of 3",
    );
    await onBand($, surface, async (ui) => {
      await ui.press({ key: "skip" });
    });

    expect(await rowText($, surface)).toBe("◇ prompt-shaper · question 3 of 3");
    // Typed while a turn runs: still the answer.
    expect(await submit($, "A nightly job", { turnId: "t1" })).toEqual(
      noted(3, 3),
    );
    await settle();

    expect(engine.requests.length).toBe(2);
    const brief = engine.requests[1];
    expect(brief?.system?.startsWith(BRIEF_START)).toBe(true);
    expect(brief?.system).toContain(
      "## Task, ## Context, ## Constraints, ## Done when",
    );
    expect(brief?.prompt).toBe(
      `${LONG}\n\nAnswers:\nQ: Which database? A: Postgres\nQ: Who runs it? A: A nightly job`,
    );
    expect(engine.filled).toEqual([{ text: MARKED, mode: "replace" }]);
    expect(engine.toasts).toEqual([READY]);
    // Nothing reached the chat: the answers were the mod's.
    expect(engine.entered).toEqual([]);
    expect(await isRowEmpty($, surface)).toBe(true);
  }
});

test("Skip all goes straight to writing with no answers", async ($, on) => {
  const engine = world(on);
  engine.replies.push('{"questions": ["One?", "Two?"]}');
  await catchLong($);
  engine.isHolding = true;
  engine.replies.push(BRIEF);

  await onBand($, "desktop", async (ui) => {
    await ui.press({ key: "skip-all" });
  });
  await settle();

  for (const surface of SURFACES) {
    expect(await rowText($, surface)).toBe(
      "◇ prompt-shaper · writing the brief…",
    );
  }

  expect(engine.requests[1]?.prompt).toBe(LONG);
  await engine.release();
  expect(engine.filled).toEqual([{ text: MARKED, mode: "replace" }]);
});

test("while asking, >> prompts, slash commands and images go to Claude", async ($, on) => {
  const engine = world(on);
  engine.replies.push('{"questions": ["One?"]}');
  await catchLong($);

  expect((await submit($, ">> what time is it")).text).toBe("what time is it");
  const slash = { command: { name: "review", args: "x" } };
  expect((await submit($, "/review x", slash)).text).toBe("/review x");
  const image = { attachments: [{ type: "image", mediaType: "image/png" }] };
  expect((await submit($, "see this", image)).text).toBe("see this");
  expect(
    (await submit($, "done", { origin: { kind: "task-notification" } })).text,
  ).toBe("done");

  // The question is still open.
  expect(await rowText($, "terminal")).toBe("◇ prompt-shaper · question 1 of 1");
  expect(engine.requests.length).toBe(1);
});

test("the box is emptied of a caught prompt and of an answer", async ($, on) => {
  const engine = world(on);
  engine.replies.push('{"questions": ["One?", "Two?"]}');
  // The box keeps the prompt after the drop, as a live session does.
  engine.box = LONG;
  await catchLong($);
  expect(engine.filled).toEqual([{ text: "", mode: "replace" }]);

  engine.filled.length = 0;
  engine.box = "Brevo";
  expect(await submit($, "Brevo")).toEqual(noted(1, 2));
  await settle();
  expect(engine.filled).toEqual([{ text: "", mode: "replace" }]);
});

test("the box is left alone when it holds other text", async ($, on) => {
  const engine = world(on);
  engine.isHolding = true;
  engine.box = "something new";
  await catchLong($);
  expect(engine.filled).toEqual([]);
});

test("while reading or writing, a typed prompt goes to Claude", async ($, on) => {
  const engine = world(on);
  engine.isHolding = true;
  engine.replies.push('{"questions": []}', BRIEF);
  await catchLong($);

  expect((await submit($, "quick question")).text).toBe("quick question");
  await engine.release();
  expect(await rowText($, "terminal")).toBe(
    "◇ prompt-shaper · writing the brief…",
  );
  expect((await submit($, "another one")).text).toBe("another one");
  expect(engine.entered).toEqual(["quick question", "another one"]);
});

test("no questions goes straight to writing", async ($, on) => {
  const engine = world(on);
  engine.isHolding = true;
  engine.replies.push('{"questions": []}', BRIEF);
  await catchLong($);
  // The question reply answers; the brief waits.
  await engine.release();

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect((await ui.find({ type: "Text", text: /◇/ }))?.text).toBe(
        "◇ prompt-shaper · writing the brief…",
      );
      expect(await ui.find({ type: "Input" })).toBeUndefined();
      expect(await ui.find({ type: "Button", key: "cancel" })).toBeDefined();
    });
  }

  await engine.release();
  expect(engine.requests.length).toBe(2);
  expect(engine.requests[1]?.prompt).toBe(LONG);
  expect(engine.filled).toEqual([{ text: MARKED, mode: "replace" }]);
});

test("bad JSON: no questions, or the first three strings found", async ($, on) => {
  const engine = world(on);
  const rounds: [string, string | undefined][] = [
    ["I have no questions.", undefined],
    ['{"questions": "none"}', undefined],
    [
      'Here: {"questions": ["A?", "B?", "C?", "D?"]} done',
      "◇ prompt-shaper · question 1 of 3",
    ],
    ['{"questions": ["Which one?", "Why', "◇ prompt-shaper · question 1 of 1"],
  ];

  for (const [reply, row] of rounds) {
    engine.requests.length = 0;
    engine.filled.length = 0;
    engine.replies.push(reply, BRIEF);
    await catchLong($);

    if (row === undefined) {
      // Straight to writing, which answered: the brief is in the box.
      expect(engine.requests.length).toBe(2);
      expect(engine.filled).toEqual([{ text: MARKED, mode: "replace" }]);
    } else {
      expect(await rowText($, "terminal")).toBe(row);
      await onBand($, "terminal", async (ui) => {
        await ui.press({ key: "skip-all" });
      });
      await settle();
      expect(engine.filled).toEqual([{ text: MARKED, mode: "replace" }]);
    }
  }
});

test("the brief comes after text typed meanwhile, the marker before both", async ($, on) => {
  const engine = world(on);
  engine.box = "typed while waiting";
  engine.replies.push('{"questions": []}', BRIEF);

  await catchLong($);

  expect(engine.filled).toEqual([
    { text: `>> typed while waiting\n\n${BRIEF}`, mode: "replace" },
  ]);
  expect(engine.toasts).toEqual([READY]);
});

test("Cancel sends the original as entered; a late answer is ignored", async ($, on) => {
  const engine = world(on);

  for (const surface of SURFACES) {
    engine.requests.length = 0;
    engine.filled.length = 0;
    engine.entered.length = 0;
    engine.isHolding = true;
    engine.replies.push('{"questions": ["Late?"]}');
    await catchLong($);

    await onBand($, surface, async (ui) => {
      await ui.press({ key: "cancel" });
    });

    // Sent once, unchanged and not caught again; the box is left alone.
    expect(engine.entered).toEqual([LONG]);
    expect(engine.filled).toEqual([]);
    expect(engine.toasts).toEqual([]);
    expect(await isRowEmpty($, surface)).toBe(true);

    // The cancelled run's reply arrives: nothing moves.
    await engine.release();
    expect(engine.requests.length).toBe(1);
    expect(engine.entered).toEqual([LONG]);
    expect(engine.filled).toEqual([]);
    expect(await isRowEmpty($, surface)).toBe(true);
  }
});

test("Cancel while asking or writing sends the original", async ($, on) => {
  const engine = world(on);
  engine.replies.push('{"questions": ["One?"]}');
  await catchLong($);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "cancel" });
  });
  expect(engine.entered).toEqual([LONG]);

  engine.entered.length = 0;
  engine.isHolding = true;
  engine.replies.push('{"questions": []}', BRIEF);
  await catchLong($);
  await engine.release();
  expect(await rowText($, "desktop")).toBe(
    "◇ prompt-shaper · writing the brief…",
  );

  await onBand($, "desktop", async (ui) => {
    await ui.press({ key: "cancel" });
  });
  await engine.release();

  expect(engine.entered).toEqual([LONG]);
  expect(engine.filled).toEqual([]);
  expect(engine.toasts).toEqual([]);
});

test("a request that is not answered puts the original back", async ($, on) => {
  const engine = world(on);

  // The question request fails.
  engine.replies.push(null);
  await catchLong($);
  expect(engine.filled).toEqual([{ text: LONG, mode: "replace" }]);
  expect(engine.entered).toEqual([]);
  expect(engine.toasts).toEqual([FAILED]);
  expect(await isRowEmpty($, "terminal")).toBe(true);

  // The brief request fails, or answers with nothing.
  for (const reply of [null, "   "]) {
    engine.filled.length = 0;
    engine.toasts.length = 0;
    engine.replies.push('{"questions": []}', reply);
    await catchLong($);
    expect(engine.requests.length % 2).toBe(1);
    expect(engine.filled).toEqual([{ text: LONG, mode: "replace" }]);
    expect(engine.toasts).toEqual([FAILED]);
  }
});

test("a prompt box that refuses the text shows it in the row", async ($, on) => {
  const engine = world(on);
  engine.isFillRefused = true;
  engine.replies.push('{"questions": []}', BRIEF);
  await catchLong($);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect((await ui.find({ type: "Text", text: /◇/ }))?.text).toContain(
        "did not take this text",
      );
      expect((await ui.find({ type: "Text", text: /## Task/ }))?.text).toBe(
        MARKED,
      );
      expect(await ui.find({ type: "Button", key: "close" })).toBeDefined();
    });
  }

  expect(engine.toasts).toEqual([]);
  // Busy while held: a new long prompt passes on.
  expect((await submit($, LONG)).text).toBe(LONG);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "close" });
  });
  expect(await isRowEmpty($, "desktop")).toBe(true);
});

test("the guard's .catch sends the prompt when the hook fails before deciding", async ($, on) => {
  const engine = world(on);
  // The state refuses every write, so the guard fails before it decides.
  on("state.set", () => ({ deny: "state unavailable" }));

  const result = await submit($, LONG);
  expect(result.drop).toBeUndefined();
  expect(result.text).toBe(LONG);
  expect(engine.entered).toEqual([LONG]);
  await settle();
  expect(engine.requests).toEqual([]);
});

test("/shape shapes its arguments; empty or busy say so", async ($, on) => {
  const engine = world(on);

  expect(await $.command.run({ ...SHAPE, args: "  " })).toEqual({
    text: "Usage: /shape <your prompt>",
    isTextDisplayOnly: true,
  });

  engine.isHolding = true;
  engine.replies.push('{"questions": []}', BRIEF);
  expect(await $.command.run({ ...SHAPE, args: " fix the login " })).toEqual({
    text: "Shaping your prompt.",
    isTextDisplayOnly: true,
  });
  await settle();
  expect(engine.requests[0]?.prompt).toBe(
    "Project folder: project\n\nPrompt:\nfix the login",
  );
  expect(await rowText($, "terminal")).toBe(
    "◇ prompt-shaper · reading your prompt…",
  );

  expect(await $.command.run({ ...SHAPE, args: "another" })).toEqual({
    text: "prompt-shaper is already busy with a prompt.",
    isTextDisplayOnly: true,
  });

  engine.isHolding = false;
  await engine.release();
  await engine.release();
  expect(engine.filled).toEqual([{ text: MARKED, mode: "replace" }]);
});

test(
  "a custom minimum length and model are used",
  { options: { minLength: 1000, model: "sonnet" } },
  async ($, on) => {
    const engine = world(on);
    engine.isHolding = true;

    expect((await submit($, "z".repeat(999))).text).toBe("z".repeat(999));
    expect(await submit($, "z".repeat(1000))).toEqual({ drop: DROP });
    await settle();
    expect(engine.requests[0]?.model).toBe("sonnet");
  },
);

test(
  "a minimum length below 100 falls back to 400",
  { options: { minLength: 50 } },
  async ($, on) => {
    const engine = world(on);
    engine.isHolding = true;

    expect((await submit($, "z".repeat(399))).text).toBe("z".repeat(399));
    expect(await submit($, "z".repeat(400))).toEqual({ drop: DROP });
    await settle();
    expect(engine.requests[0]?.model).toBe("haiku");
  },
);

test("at the default, a 450-character prompt is caught and a 399-character one is not", async ($, on) => {
  const engine = world(on);
  engine.isHolding = true;

  expect((await submit($, "q".repeat(399))).text).toBe("q".repeat(399));
  expect(engine.requests).toEqual([]);
  expect(await submit($, "q".repeat(450))).toEqual({ drop: DROP });
  await settle();
  expect(engine.requests.length).toBe(1);
});

test("session.start registers /shape and never resets a run", async ($, on) => {
  const engine = world(on);
  engine.isHolding = true;
  await catchLong($);

  expect(
    await $.session.start({
      cwd: ROOT,
      surface: "terminal",
      isInteractive: true,
    }),
  ).toEqual({ cwd: ROOT });
  expect(engine.commands).toEqual(["shape"]);
  expect(await rowText($, "terminal")).toBe(
    "◇ prompt-shaper · reading your prompt…",
  );
});

test("/clear ends a run and puts the original back", async ($, on) => {
  const engine = world(on);
  engine.isHolding = true;
  engine.replies.push('{"questions": ["Late?"]}');
  await catchLong($);

  expect(
    await $.session.end({
      reason: "clear",
      sessionId: "s1",
      resume: {} as never,
    }),
  ).toEqual({ sessionId: "s1" });
  await settle();
  expect(engine.filled).toEqual([{ text: LONG, mode: "replace" }]);
  expect(engine.entered).toEqual([]);

  await engine.release();
  expect(engine.requests.length).toBe(1);
  expect(await isRowEmpty($, "terminal")).toBe(true);
});

test("other hooks pass events on unchanged; a survey keeps the row away", async ($, on) => {
  const engine = world(on);
  engine.isHolding = true;
  await catchLong($);

  expect(await $.command.run({ ...SHAPE, command: "help", args: "" })).toEqual({
    text: "ran help",
  });

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      ...BAND,
      surface,
      props: { ...BAND.props, hasSurvey: true },
    });
    expect(await ui.keepsBeneath()).toBe(true);
    await ui.unmount();
  }
});

test("a state write failing while asking ends the run and puts the original back", async ($, on) => {
  const engine = world(on);
  let isBroken = false;
  on("state.set", (_, e, next) =>
    isBroken ? { deny: "state unavailable" } : next(e),
  );

  for (const surface of SURFACES) {
    engine.filled.length = 0;
    engine.toasts.length = 0;
    engine.replies.push('{"questions": ["One?", "Two?"]}');
    await catchLong($);
    expect(await rowText($, surface)).toBe("◇ prompt-shaper · question 1 of 2");

    isBroken = true;
    engine.entered.length = 0;
    // The answer is not eaten: it goes on to Claude.
    expect((await submit($, "yes")).text).toBe("yes");
    await settle();
    isBroken = false;
    expect(engine.entered).toEqual(["yes"]);

    expect(engine.filled).toEqual([{ text: LONG, mode: "replace" }]);
    expect(engine.toasts).toEqual([FAILED]);

    // The row's step was left behind by the failed write: Close clears it.
    await onBand($, surface, async (ui) => {
      if (!(await ui.keepsBeneath())) {
        await ui.press({ key: "close" });
      }
    });
    expect(await isRowEmpty($, surface)).toBe(true);
  }
});

test("a cancel while the questions are being written leaves none behind", async ($, on) => {
  const engine = world(on);
  let isCancelling = false;
  // The questions values that landed, in order.
  const written: unknown[] = [];
  on("state.set", async (_, e, next) => {
    // Cancel lands while the questions are being written, before they land.
    if (
      isCancelling &&
      e.key === "questions" &&
      Array.isArray(e.value) &&
      e.value.length > 0
    ) {
      isCancelling = false;
      const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
      await ui.press({ key: "cancel" });
      await ui.unmount();
    }

    const result = await next(e);

    // A $ call's answer beneath the plugin: `{ value }`, here the write's result.
    const landed = (result as { value?: { isSet?: boolean } }).value?.isSet;

    if (e.key === "questions" && landed === true) {
      written.push(e.value);
    }

    return result;
  });

  isCancelling = true;
  engine.replies.push('{"questions": ["One?"]}');
  await catchLong($);

  expect(engine.entered).toEqual([LONG]);
  // The last questions written are none.
  expect(written[written.length - 1]).toEqual([]);
  for (const surface of SURFACES) {
    expect(await isRowEmpty($, surface)).toBe(true);
  }
});

test("/shape that fails to start says so", async ($, on) => {
  world(on);
  on("state.set", () => ({ deny: "state unavailable" }));

  expect(await $.command.run({ ...SHAPE, args: "fix the login" })).toEqual({
    text: "prompt-shaper could not start.",
    isTextDisplayOnly: true,
  });
});

test("a shaped brief is sent, not caught again, also when edited", async ($, on) => {
  const engine = world(on);
  // A brief as long as a real one: over the 400-character threshold.
  const longBrief = `## Task\nBuild the CSV importer.\n\n## Context\n${"Orders come from the shop. ".repeat(20)}`.trim();
  engine.replies.push('{"questions": []}', longBrief);
  await catchLong($);
  expect(engine.filled).toEqual([{ text: `>> ${longBrief}`, mode: "replace" }]);

  // Sent from the box: the marker is removed, the brief goes out unchanged.
  expect((await submit($, `>> ${longBrief}`)).text).toBe(longBrief);

  const edited = `${longBrief}\n\n## Done when\nOrders import without errors.`;
  expect((await submit($, `>> ${edited}`)).text).toBe(edited);
  expect(engine.requests.length).toBe(2);
});

test("a draft that already starts with >> gets no second marker", async ($, on) => {
  const engine = world(on);
  engine.box = ">> typed while waiting";
  engine.replies.push('{"questions": []}', BRIEF);
  await catchLong($);

  expect(engine.filled).toEqual([
    { text: `>> typed while waiting\n\n${BRIEF}`, mode: "replace" },
  ]);
});

test("Cancel with text typed meanwhile sends the original and leaves the box", async ($, on) => {
  const engine = world(on);
  engine.box = "typed while waiting";
  engine.isHolding = true;
  engine.replies.push('{"questions": []}', BRIEF);
  await catchLong($);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "cancel" });
  });
  await settle();

  expect(engine.entered).toEqual([LONG]);
  expect(engine.filled).toEqual([]);
});

test("Cancel whose send is refused puts the original back, marked", async ($, on) => {
  const engine = world(on);
  engine.isSendRefused = true;
  engine.isHolding = true;
  engine.replies.push('{"questions": []}');
  await catchLong($);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "cancel" });
  });
  await settle();

  expect(engine.entered).toEqual([]);
  // Enter then sends it unchanged: the guard removes the marker.
  expect(engine.filled).toEqual([{ text: `>> ${LONG}`, mode: "replace" }]);
  expect((await submit($, `>> ${LONG}`)).text).toBe(LONG);
});

test("Cancel on a prompt with an @ mention puts it back marked, unsent", async ($, on) => {
  const engine = world(on);
  const withMention = `${LONG} See @src/Importer.php for the current code.`;
  engine.isHolding = true;
  engine.replies.push('{"questions": []}');
  await catchLong($, withMention);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "cancel" });
  });
  await settle();

  expect(engine.entered).toEqual([]);
  expect(engine.filled).toEqual([
    { text: `>> ${withMention}`, mode: "replace" },
  ]);
});

test("Cancel whose send throws puts the original back, marked", async ($, on) => {
  const engine = world(on);
  engine.isSendThrowing = true;
  engine.isHolding = true;
  engine.replies.push('{"questions": []}');
  await catchLong($);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "cancel" });
  });
  await settle();

  expect(engine.entered).toEqual([]);
  expect(engine.filled).toEqual([{ text: `>> ${LONG}`, mode: "replace" }]);
});
