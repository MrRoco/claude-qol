import { expect, mock, test } from "claude-code/testing";
import type { Engine, Mounted } from "claude-code/testing";
import type {
  CommandInfo,
  ModelForkResult,
  ModelUsage,
  On,
  TurnStepChunk,
  TurnStepResult,
  TurnUsage,
} from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;
type Surface = (typeof SURFACES)[number];

const START = 1_000_000;
const MINUTE = 60_000;
const PING = "cache-timer keep-warm ping. Reply with only: ok";

const BAND = {
  plugin: "cache-timer",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

const ZERO: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const usage = (write5m: number, write1h: number): TurnUsage => ({
  input_tokens: 20,
  output_tokens: 4,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: write5m + write1h,
  ephemeral_5m_input_tokens: write5m,
  ephemeral_1h_input_tokens: write1h,
  model: "claude-test",
});
const WRITE_1H = usage(0, 1_200);
const WRITE_5M = usage(1_200, 0);
// A step that only read the cache: no lifetime named.
const READ_ONLY: TurnUsage = {
  ...ZERO,
  cache_read_input_tokens: 40_000,
  model: "claude-test",
};

const ANSWERED: ModelForkResult = {
  isAnswered: true,
  text: "ok",
  usage: {
    ...ZERO,
    cache_read_input_tokens: 43_000,
    input_tokens: 20,
    output_tokens: 4,
  },
};

const FRESH_LISTED: CommandInfo = {
  name: "fresh",
  description: "Write a handoff",
  source: "plugin",
  plugin: "fresh-start",
};

const CHUNK: TurnStepChunk = { kind: "text", index: 0, text: "hi" };

type WorldOptions = {
  commands?: CommandInfo[];
  threshold?: unknown;
  isCommandRejected?: boolean;
};

type World = {
  forks: Record<string, unknown>[];
  commands: string[];
  toasts: string[];
  invalidates: { count: number };
  // What the next fork answers, and what it adds to the session's cost.
  fork: { reply: ModelForkResult; cost: number; gate?: Promise<void> };
  // The usage the next main or subagent step reports.
  step: { usage: TurnUsage | null };
  cost: { usd: number | undefined };
  advance: (ms: number) => Promise<void>;
};

/**
 * Stands in for the engine beneath the mod: each hook answers as the engine
 * would, records what the mod asked for, and its answers are what the mod
 * must hand back unchanged.
 */
const world = (on: On, options: WorldOptions = {}): World => {
  const clock = mock.clock(on, { now: START });
  const result: World = {
    forks: [],
    commands: [],
    toasts: [],
    invalidates: { count: 0 },
    fork: { reply: ANSWERED, cost: 0.02 },
    step: { usage: WRITE_1H },
    cost: { usd: 1 },
    advance: (ms) => clock.advance(ms),
  };

  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("turn.step", async function* (_, e): AsyncGenerator<
    TurnStepChunk,
    TurnStepResult
  > {
    yield CHUNK;

    return {
      turnId: e.turnId,
      index: e.index,
      answer: "hi",
      toolUses: [],
      stopReason: "end_turn",
      usage: result.step.usage,
    };
  });
  on("ui.invalidate", () => {
    result.invalidates.count += 1;

    return { value: undefined };
  });
  on("ui.toast", (_, e) => {
    result.toasts.push(e.text);

    return { value: undefined };
  });
  on("session.usage", () => ({
    value: {
      startedAt: START,
      context: {} as never,
      rateLimits: [],
      ...(result.cost.usd === undefined
        ? {}
        : { cost: { usd: result.cost.usd } }),
    },
  }));
  on("model.fork", async (_, e) => {
    result.forks.push({ ...e });
    await result.fork.gate;

    if (result.cost.usd !== undefined) {
      result.cost.usd += result.fork.cost;
    }

    return { value: result.fork.reply };
  });
  on("command.list", () => ({ value: options.commands ?? [] }));
  on("config.list", () => ({
    value:
      options.threshold === undefined
        ? []
        : [
            {
              key: "fresh-start.threshold",
              label: "Offer threshold (tokens)",
              kind: "number" as const,
              value: options.threshold as number,
              provider: { plugin: "fresh-start", tier: "user" } as never,
              isLocked: false,
            },
          ],
  }));
  on("command.run", (_, e) => {
    if (options.isCommandRejected === true) {
      throw new Error("refused");
    }

    result.commands.push(e.command);

    return { text: "" };
  });

  return result;
};

/** One model request through the hooks, read to its end like the engine. */
const step = async (
  $: Engine,
  engine: World,
  stepUsage: TurnUsage | null,
  agentId?: string,
) => {
  engine.step.usage = stepUsage;
  const stream = $.turn.step({
    turnId: "turn-1",
    index: 0,
    model: "claude-test",
    messageCount: 3,
    ...(agentId === undefined ? {} : { agentId }),
  });
  const chunks: TurnStepChunk[] = [];
  // Read by hand: the generator's return value is the step's result.
  let item = await stream.next();

  while (item.done !== true) {
    chunks.push(item.value);
    item = await stream.next();
  }

  return { chunks, result: item.value };
};

const completeTurn = ($: Engine, agentId?: string) =>
  $.turn.complete({
    answer: "done",
    durationMs: 10,
    isAborted: false,
    turnId: "turn-1",
    reason: "answer",
    ...(agentId === undefined ? {} : { agentId }),
  });

const measure = ($: Engine, tokens: number) =>
  $.session.measure({
    context: {
      tokens,
      window: 1_000_000,
      percent: Math.round(tokens / 10_000),
    },
    rateLimits: [],
    changed: ["context"],
  });

/** A main answer that wrote the cache, then the turn's end. */
const answer = async ($: Engine, engine: World, stepUsage = WRITE_1H) => {
  await step($, engine, stepUsage);
  await completeTurn($);
};

type Band = Mounted<Surface, "AbovePrompt">;

/** Mounts the row on the surface, runs the body, unmounts. */
const onBand = async (
  $: Engine,
  surface: Surface,
  body: (ui: Band) => Promise<void>,
  props: {
    isWorking?: boolean;
    hasSurvey?: boolean;
    bodyColumns?: number;
  } = {},
) => {
  const ui = await $.ui.mount({
    ...BAND,
    surface,
    props: { ...BAND.props, ...props },
  });
  await body(ui);
  await ui.unmount();
};

const textOf = async (ui: Band, pattern: RegExp) =>
  (await ui.find({ type: "Text", text: pattern }))?.text;

test("a 1 h write counts down from an hour, a 5 min write from five minutes", async ($, on) => {
  const engine = world(on);
  await answer($, engine, WRITE_1H);
  await engine.advance(3 * MINUTE);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 57:00 left");
      expect(await textOf(ui, /· 1 h/)).toBe(" · 1 h");
      expect(await textOf(ui, /Cache warm/)).toBe("◷ Cache warm  ");
      expect((await ui.find({ type: "Text", text: /left/ }))?.props.color).toBe(
        "claude",
      );
      expect(await ui.find({ type: "Button", key: "keep-warm" })).toBeDefined();
    });
  }

  await answer($, engine, WRITE_5M);
  await engine.advance(3 * MINUTE);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 2:00 left");
      expect(await textOf(ui, /· 5 min/)).toBe(" · 5 min");
    });
  }
});

test("an hour or more left reads h:mm:ss", async ($, on) => {
  const engine = world(on);
  await answer($, engine, WRITE_1H);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 1:00:00 left");
    });
  }
});

test("a read-only step keeps the lifetime and restarts the countdown", async ($, on) => {
  const engine = world(on);
  await answer($, engine, WRITE_1H);
  await engine.advance(10 * MINUTE);
  await step($, engine, READ_ONLY);
  await engine.advance(3 * MINUTE);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 57:00 left");
      expect(await textOf(ui, /· 1 h/)).toBe(" · 1 h");
    });
  }
});

test("a step without a response leaves the countdown as it was", async ($, on) => {
  const engine = world(on);
  await answer($, engine, WRITE_1H);
  await engine.advance(3 * MINUTE);
  await step($, engine, null);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 57:00 left");
    });
  }
});

test("subagent steps change nothing", async ($, on) => {
  const engine = world(on);
  await step($, engine, WRITE_5M, "agent-1");
  await completeTurn($, "agent-1");

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }

  await answer($, engine, WRITE_1H);
  await engine.advance(3 * MINUTE);
  await step($, engine, WRITE_5M, "agent-1");

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 57:00 left");
      expect(await textOf(ui, /· 1 h/)).toBe(" · 1 h");
    });
  }
});

test("no row before the first answer, while working, or with a survey", async ($, on) => {
  const engine = world(on);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
      expect(
        await ui.find({ type: "Button", key: "keep-warm" }),
      ).toBeUndefined();
    });
  }

  await answer($, engine);

  for (const surface of SURFACES) {
    await onBand(
      $,
      surface,
      async (ui) => {
        expect(await ui.keepsBeneath()).toBe(true);
        expect(await textOf(ui, /Cache/)).toBeUndefined();
      },
      { isWorking: true },
    );
    await onBand(
      $,
      surface,
      async (ui) => {
        expect(await ui.keepsBeneath()).toBe(true);
        expect(await textOf(ui, /Cache/)).toBeUndefined();
      },
      { hasSurvey: true },
    );
  }
});

test("the last minute is drawn in the warning colour; at zero the cold row shows the tokens", async ($, on) => {
  const engine = world(on);
  await measure($, 252_400);
  await answer($, engine, WRITE_5M);
  await engine.advance(4 * MINUTE + 30_000);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      const time = await ui.find({ type: "Text", text: /left/ });
      expect(time?.text).toBe("▏ 0:30 left");
      expect(time?.props.color).toBe("warning");
      expect(
        (await ui.find({ type: "Text", text: /Cache warm/ }))?.props.color,
      ).toBe("warning");
    });
  }

  await engine.advance(30_000);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      const cold = await ui.find({ type: "Text", text: /Cache cold/ });
      expect(cold?.text).toBe(
        "○ Cache cold · the next message re-reads 252k tokens at full price",
      );
      expect(cold?.props.dimColor).toBe(true);
      expect(await ui.find({ type: "Button", key: "hide" })).toBeDefined();
      expect(
        await ui.find({ type: "Button", key: "keep-warm" }),
      ).toBeUndefined();
      expect(
        await ui.find({ type: "Button", key: "start-fresh" }),
      ).toBeUndefined();
    });
  }
});

test("Keep warm forks once without effort, restarts from the send time and shows the cost", async ($, on) => {
  const engine = world(on);
  await answer($, engine, WRITE_5M);
  await engine.advance(3 * MINUTE);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "keep-warm" });
  });

  expect(engine.forks).toEqual([{ prompt: PING }]);
  expect("effort" in (engine.forks[0] ?? {})).toBe(false);
  await engine.advance(MINUTE);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 4:00 left");
      expect(await textOf(ui, /· 5 min/)).toBe(" · 5 min");
      expect(await textOf(ui, /kept warm/)).toBe(" · kept warm $0.02");
      expect(
        (await ui.find({ type: "Text", text: /kept warm/ }))?.props.dimColor,
      ).toBe(true);
    });
  }

  expect(engine.toasts).toEqual([]);
});

test("Keep warm leaves the cost out when the session has no cost", async ($, on) => {
  const engine = world(on);
  engine.cost.usd = undefined;
  await answer($, engine);
  await engine.advance(3 * MINUTE);

  await onBand($, "desktop", async (ui) => {
    await ui.press({ key: "keep-warm" });
  });

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 1:00:00 left");
      expect(await textOf(ui, /kept warm/)).toBeUndefined();
    });
  }
});

test("Keep warm is ignored within 10 s of the turn's end", async ($, on) => {
  const engine = world(on);
  await answer($, engine);
  await engine.advance(5_000);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      await ui.press({ key: "keep-warm" });
    });
  }

  expect(engine.forks.length).toBe(0);
  await engine.advance(5_000);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "keep-warm" });
  });

  expect(engine.forks.length).toBe(1);
});

test("Keep warm is ignored while one is in flight; the row says so", async ($, on) => {
  const engine = world(on);
  await answer($, engine);
  await engine.advance(3 * MINUTE);
  let release = () => {};
  engine.fork.gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Two drawings pressed at once: only one press may send a request. A
  // press on a drawing that already redrew without the button is refused.
  const drawings = await Promise.all(
    SURFACES.map((surface) => $.ui.mount({ ...BAND, surface })),
  );
  await Promise.allSettled(
    drawings.map((ui) => ui.press({ key: "keep-warm" })),
  );

  for (const ui of drawings) {
    await ui.unmount();
  }

  expect(engine.forks.length).toBe(1);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /Keeping warm/)).toBe("◷ Keeping warm…");
      expect(
        await ui.find({ type: "Button", key: "keep-warm" }),
      ).toBeUndefined();
    });
  }

  release();
  await engine.advance(0);

  await onBand($, "terminal", async (ui) => {
    expect(await textOf(ui, /left/)).toBe("▏ 1:00:00 left");
    expect(await ui.find({ type: "Button", key: "keep-warm" })).toBeDefined();
  });
});

test("each Keep warm failure gives its toast and leaves the countdown", async ($, on) => {
  const engine = world(on);
  await answer($, engine);
  await engine.advance(3 * MINUTE);

  const failures: [ModelForkResult, string][] = [
    [
      {
        isAnswered: false,
        reason: "nothing-to-fork",
        usage: ZERO,
      } as ModelForkResult,
      "Nothing to keep warm yet.",
    ],
    [
      {
        isAnswered: false,
        reason: "api-error",
        status: 529,
        error: "overloaded",
        usage: ZERO,
      },
      "Keep warm failed (529).",
    ],
    [
      { isAnswered: false, reason: "empty-reply", usage: ZERO },
      "Keep warm got no reply.",
    ],
    [
      { isAnswered: false, reason: "aborted", usage: ZERO },
      "Keep warm got no reply.",
    ],
  ];

  for (const [reply, toast] of failures) {
    engine.fork.reply = reply;
    engine.toasts.length = 0;

    await onBand($, "terminal", async (ui) => {
      await ui.press({ key: "keep-warm" });
    });

    expect(engine.toasts).toEqual([toast]);

    for (const surface of SURFACES) {
      await onBand($, surface, async (ui) => {
        expect(await textOf(ui, /left/)).toBe("▏ 57:00 left");
        expect(await textOf(ui, /kept warm/)).toBeUndefined();
        expect(
          await ui.find({ type: "Button", key: "keep-warm" }),
        ).toBeDefined();
      });
    }
  }

  expect(engine.forks.length).toBe(failures.length);
});

test("Start fresh shows only when cold, big and fresh-start is listed; the press runs it", async ($, on) => {
  const engine = world(on, { commands: [FRESH_LISTED] });
  await measure($, 260_000);
  await answer($, engine, WRITE_5M);
  await engine.advance(3 * MINUTE);

  // Warm: never offered.
  await onBand($, "terminal", async (ui) => {
    expect(
      await ui.find({ type: "Button", key: "start-fresh" }),
    ).toBeUndefined();
  });

  await engine.advance(2 * MINUTE);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(
        await ui.find({ type: "Button", key: "start-fresh" }),
      ).toBeDefined();
      expect(await ui.find({ type: "Button", key: "hide" })).toBeDefined();
    });
  }

  await onBand($, "desktop", async (ui) => {
    await ui.press({ key: "start-fresh" });
  });
  await engine.advance(0);

  expect(engine.commands).toEqual(["fresh"]);
  expect(engine.forks.length).toBe(0);
});

test("Start fresh is not drawn below the threshold", async ($, on) => {
  const engine = world(on, { commands: [FRESH_LISTED] });
  await measure($, 249_999);
  await answer($, engine, WRITE_5M);
  await engine.advance(6 * MINUTE);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /Cache cold/)).toBeDefined();
      expect(
        await ui.find({ type: "Button", key: "start-fresh" }),
      ).toBeUndefined();
    });
  }
});

test("Start fresh is not drawn when fresh-start is not listed", async ($, on) => {
  const engine = world(on, {
    commands: [{ name: "fresh", description: "other", source: "user" }],
  });
  await measure($, 400_000);
  await answer($, engine, WRITE_5M);
  await engine.advance(6 * MINUTE);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(
        await ui.find({ type: "Button", key: "start-fresh" }),
      ).toBeUndefined();
    });
  }
});

test("fresh-start's own threshold and a prefixed command name are used", async ($, on) => {
  const engine = world(on, {
    commands: [{ ...FRESH_LISTED, name: "fresh-start:fresh" }],
    threshold: 50_000,
  });
  await measure($, 60_000);
  await answer($, engine, WRITE_5M);
  await engine.advance(6 * MINUTE);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(
        await ui.find({ type: "Button", key: "start-fresh" }),
      ).toBeDefined();
    });
  }

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "start-fresh" });
  });
  await engine.advance(0);

  expect(engine.commands).toEqual(["fresh-start:fresh"]);
});

test("a refused Start fresh shows a toast", async ($, on) => {
  const engine = world(on, {
    commands: [FRESH_LISTED],
    isCommandRejected: true,
  });
  await measure($, 300_000);
  await answer($, engine, WRITE_5M);
  await engine.advance(6 * MINUTE);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "start-fresh" });
  });
  await engine.advance(0);

  expect(engine.toasts).toEqual(["Could not start fresh-start."]);
});

test("Hide hides the cold row until the next main request", async ($, on) => {
  const engine = world(on);
  await answer($, engine, WRITE_5M);
  await engine.advance(6 * MINUTE);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "hide" });
  });

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
      expect(await textOf(ui, /Cache/)).toBeUndefined();
    });
  }

  await step($, engine, WRITE_5M, "agent-1");

  await onBand($, "desktop", async (ui) => {
    expect(await textOf(ui, /Cache/)).toBeUndefined();
  });

  await step($, engine, READ_ONLY);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 5:00 left");
    });
  }
});

test("the ticker starts after a main turn and stops once drawn cold", async ($, on) => {
  const engine = world(on);
  await step($, engine, WRITE_5M);
  await engine.advance(3_000);
  expect(engine.invalidates.count).toBe(0);

  await completeTurn($);
  await engine.advance(3_000);
  expect(engine.invalidates.count).toBe(3);

  // Cold, and drawn so: the next tick stops the ticker.
  await engine.advance(5 * MINUTE);
  await onBand($, "terminal", async (ui) => {
    expect(await textOf(ui, /Cache cold/)).toBeDefined();
  });
  await engine.advance(1_000);
  const stopped = engine.invalidates.count;
  await engine.advance(10_000);
  expect(engine.invalidates.count).toBe(stopped);
});

test("a subagent's turn end starts no ticker", async ($, on) => {
  const engine = world(on);
  await step($, engine, WRITE_5M, "agent-1");
  await completeTurn($, "agent-1");
  await engine.advance(3_000);
  expect(engine.invalidates.count).toBe(0);
});

test("session.start restarts the ticker only with a known time and keeps the state", async ($, on) => {
  const engine = world(on);
  await $.session.start({ cwd: "/work" } as never);
  await engine.advance(3_000);
  expect(engine.invalidates.count).toBe(0);

  await answer($, engine);
  // Timers stop at a reload; the session's end is how the test stops them.
  await $.session.end({ sessionId: "s-1", reason: "other" } as never);
  const before = engine.invalidates.count;
  await engine.advance(3_000);
  expect(engine.invalidates.count).toBe(before);

  await $.session.start({ cwd: "/work" } as never);
  await engine.advance(3_000);
  expect(engine.invalidates.count).toBe(before + 3);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await textOf(ui, /left/)).toBe("▏ 59:54 left");
    });
  }
});

test("hooks pass events through unchanged", async ($, on) => {
  const engine = world(on);

  const { chunks, result } = await step($, engine, WRITE_1H);
  expect(chunks).toEqual([CHUNK]);
  expect(result).toEqual({
    turnId: "turn-1",
    index: 0,
    answer: "hi",
    toolUses: [],
    stopReason: "end_turn",
    usage: WRITE_1H,
  });

  const subagent = await step($, engine, WRITE_5M, "agent-1");
  expect(subagent.chunks).toEqual([CHUNK]);
  expect(subagent.result.usage).toEqual(WRITE_5M);

  expect(await completeTurn($)).toEqual({ text: "done" });
  expect(await measure($, 1_000)).toEqual({ changed: ["context"] });
  expect(await $.session.start({ cwd: "/work" } as never)).toEqual({
    cwd: "/work",
  });
  expect(
    await $.session.end({ sessionId: "s-1", reason: "other" } as never),
  ).toEqual({
    sessionId: "s-1",
  });
});

test("from 100 columns the row takes at most half; below that the full width", async ($, on) => {
  const engine = world(on);
  await answer($, engine);
  await engine.advance(3 * MINUTE);

  const cellsOf = async (ui: Band) =>
    (await ui.findAll({ type: "Text", text: /^[█░]+$/ }))
      .map((cell) => cell.text)
      .join("").length;

  for (const surface of SURFACES) {
    await onBand(
      $,
      surface,
      async (ui) => {
        expect((await ui.find({ type: "Box" }))?.props.width).toBe(59);
        expect(
          await ui.find({ type: "Button", key: "keep-warm" }),
        ).toBeDefined();
        expect(await cellsOf(ui)).toBeGreaterThanOrEqual(10);
        expect(await cellsOf(ui)).toBeLessThanOrEqual(59 - 14 - 13);
      },
      { bodyColumns: 120 },
    );
    await onBand(
      $,
      surface,
      async (ui) => {
        expect((await ui.find({ type: "Box" }))?.props.width).toBe(80);
        expect(
          await ui.find({ type: "Button", key: "keep-warm" }),
        ).toBeDefined();
        expect(await cellsOf(ui)).toBeGreaterThanOrEqual(10);
      },
      { bodyColumns: 80 },
    );
  }

  // The cold row follows the same rule.
  await engine.advance(MINUTE * 60);

  for (const surface of SURFACES) {
    await onBand(
      $,
      surface,
      async (ui) => {
        expect((await ui.find({ type: "Box" }))?.props.width).toBe(59);
        expect(await ui.find({ type: "Button", key: "hide" })).toBeDefined();
      },
      { bodyColumns: 120 },
    );
  }
});
