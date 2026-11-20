import { expect, mock, test } from "claude-code/testing";
import type { Engine, Mounted } from "claude-code/testing";
import type { On } from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;
const ROOT = "/work/project";
// 20-11-2026 14:32:10 in local time, as the file name reads it.
const START = new Date(2026, 10, 20, 14, 32, 10).getTime();
const BASE = "2026-11-20-1432";
const HANDOFF = "# Handoff: Ship the importer\n## Goal\nFinish the CSV import.";

const FRESH = {
  command: "fresh",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 120 },
} as const;

const BAND = {
  plugin: "fresh-start",
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

type World = {
  submitted: string[];
  writes: { path: string; text: string }[];
  commands: string[];
  filled: string[];
  copied: { text: string; surface: string | undefined }[];
  toasts: string[];
  store: Map<string, unknown>;
  // Order of the engine calls that matter for Start fresh.
  calls: string[];
  advance: (ms: number) => Promise<void>;
  // Empties the records between rounds of one test.
  reset: () => void;
};

type WorldOptions = {
  isFillRefused?: boolean;
  isCopied?: boolean;
  failWrite?: string;
  isSubmitDropped?: boolean;
  root?: string;
  runs?: unknown[];
  // What the host's /clear does beyond answering, run inside its hook.
  onClear?: () => Promise<unknown>;
  // What happens elsewhere while the clipboard is being written.
  onCopy?: () => Promise<unknown>;
  // What happens while the handoff file (not the .gitignore) is written.
  onWrite?: () => Promise<unknown>;
};

/**
 * Stands in for the engine beneath the mod: each hook answers as the engine
 * would and records what the mod asked for.
 */
const world = (on: On, options: WorldOptions = {}): World => {
  const clock = mock.clock(on, { now: START });
  const result: World = {
    submitted: [],
    writes: [],
    commands: [],
    filled: [],
    copied: [],
    toasts: [],
    store: new Map<string, unknown>(
      options.runs === undefined ? [] : [["runs", options.runs]],
    ),
    calls: [],
    advance: (ms) => clock.advance(ms),
    reset: () => {
      for (const list of [
        result.submitted,
        result.writes,
        result.commands,
        result.filled,
        result.copied,
        result.toasts,
        result.calls,
      ]) {
        list.length = 0;
      }
    },
  };

  on("command.register", () => ({ value: { command: "fresh" } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("session.root", () => ({ value: options.root ?? ROOT }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("prompt.submit", (_, e) => {
    result.submitted.push(e.text);

    return options.isSubmitDropped === true
      ? { drop: "busy" }
      : { text: e.text };
  });
  on("command.run", async (_, e) => {
    result.commands.push(e.command);
    result.calls.push(`command:${e.command}`);

    if (e.command === "clear" && options.onClear !== undefined) {
      await options.onClear();
    }

    return { text: "" };
  });
  on("prompt.fill", (_, e) => {
    result.calls.push("fill");

    if (options.isFillRefused === true) {
      return { isFilled: false, refusal: "no_composer" as const };
    }

    result.filled.push(e.text);

    return { isFilled: true };
  });
  on("ui.copy", async (_, e) => {
    result.copied.push({ text: e.text, surface: e.surface });
    result.calls.push("copy");
    await options.onCopy?.();

    return {
      value:
        options.isCopied === false
          ? { isCopied: false as const, reason: "no-clipboard" as const }
          : { isCopied: true as const },
    };
  });
  on("ui.toast", (_, e) => {
    result.toasts.push(e.text);

    return { value: undefined };
  });
  on("fs.write", async (_, e) => {
    if (options.failWrite !== undefined && !e.path.endsWith(".gitignore")) {
      return { deny: options.failWrite };
    }

    if (!e.path.endsWith(".gitignore")) {
      await options.onWrite?.();
    }

    result.writes.push({ path: e.path, text: e.text });

    return { value: undefined };
  });
  on("store.get", (_, e) => ({ value: result.store.get(e.key) }));
  on("store.set", (_, e) => {
    result.store.set(e.key, e.value);

    return { value: undefined };
  });

  return result;
};

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

const completeTurn = (
  $: Engine,
  turnId: string,
  answer: string,
  extra: { agentId?: string; reason?: "answer" | "aborted" | "error" } = {},
) =>
  $.turn.complete({
    answer,
    durationMs: 10,
    isAborted: extra.reason === "aborted",
    turnId,
    reason: extra.reason ?? "answer",
    ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
  });

/**
 * Runs /fresh as the person would; the mod hands its submit to the clock,
 * which runs it once the command has answered.
 */
const runFresh = async ($: Engine, engine: World) => {
  const reply = await $.command.run(FRESH);
  await engine.advance(0);

  return reply;
};

/** Runs the handoff turn as the engine would: its start, then its answer. */
const answerHandoff = async (
  $: Engine,
  engine: World,
  answer = HANDOFF,
  reason: "answer" | "aborted" | "error" = "answer",
) => {
  const prompt = engine.submitted[engine.submitted.length - 1] ?? "";
  await $.turn.start({ text: prompt, turnId: "handoff-1" });
  await completeTurn($, "handoff-1", answer, { reason });
};

/** Mounts the row on the surface, runs the body, unmounts. */
const onBand = async (
  $: Engine,
  surface: (typeof SURFACES)[number],
  body: (ui: Mounted<(typeof SURFACES)[number], "AbovePrompt">) => Promise<void>,
) => {
  const ui = await $.ui.mount({ ...BAND, surface });
  await body(ui);
  await ui.unmount();
};

/** Drives one run to the choose row through the Write handoff press. */
const toChoose = async ($: Engine, engine: World) => {
  await measure($, 260_000);
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "write" });
  });
  await answerHandoff($, engine);
};

test("below the threshold nothing is drawn; at it the offer shows 252k", async ($, on) => {
  world(on);
  await measure($, 249_999);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }

  await measure($, 252_400);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      const lead = await ui.find({ type: "Text", text: /This chat/ });
      expect(lead?.text).toBe("◆ This chat is at 252k tokens.");
      expect(lead?.props.color).toBe("claude");
      expect(await ui.find({ type: "Button", key: "write" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "not-now" })).toBeDefined();
    });
  }
});

test("a measure without tokens changes nothing", async ($, on) => {
  world(on);
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [],
    changed: ["context"],
  });

  await onBand($, "terminal", async (ui) => {
    expect(await ui.keepsBeneath()).toBe(true);
  });
});

test(
  "a custom threshold is used",
  { options: { threshold: 30_000 } },
  async ($, on) => {
    world(on);
    await measure($, 29_000);

    await onBand($, "terminal", async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });

    await measure($, 31_000);

    for (const surface of SURFACES) {
      await onBand($, surface, async (ui) => {
        expect((await ui.find({ type: "Text", text: /This chat/ }))?.text).toBe(
          "◆ This chat is at 31k tokens.",
        );
      });
    }
  },
);

test(
  "a threshold below 20,000 falls back to 250,000",
  { options: { threshold: 5_000 } },
  async ($, on) => {
    world(on);
    await measure($, 100_000);

    await onBand($, "terminal", async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });

    await measure($, 250_000);

    await onBand($, "terminal", async (ui) => {
      expect((await ui.find({ type: "Text", text: /This chat/ }))?.text).toBe(
        "◆ This chat is at 250k tokens.",
      );
    });
  },
);

test("Not now hides the offer for good; /fresh still starts", async ($, on) => {
  const engine = world(on);
  await measure($, 260_000);
  await onBand($, "desktop", async (ui) => {
    await ui.press({ key: "not-now" });
  });
  await measure($, 300_000);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }

  const reply = await runFresh($, engine);
  expect(reply.text).toBe("Writing a handoff of this chat.");
  expect(engine.submitted.length).toBe(1);
});

test("Write handoff submits the handoff prompt and shows the step strip", async ($, on) => {
  const engine = world(on);
  await measure($, 260_000);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "write" });
  });

  expect(engine.submitted.length).toBe(1);
  const prompt = engine.submitted[0] ?? "";
  expect(
    prompt.startsWith("fresh-start: please write a handoff of this whole chat"),
  ).toBe(true);
  expect(prompt).toContain("## Next steps - numbered, concrete, in order");
  expect(prompt).toContain(
    "Never include passwords, API keys, tokens or other secrets.",
  );

  await engine.advance(42_000);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      const step = await ui.find({ type: "Text", text: /Writing/ });
      expect(step?.text).toBe("① Writing ▕");
      expect(step?.props.color).toBe("claude");
      expect((await ui.find({ type: "Text", text: /0:42/ }))?.text).toBe(
        "▏ 0:42",
      );
      const later = await ui.find({ type: "Text", text: /Saving/ });
      expect(later?.text).toBe("  ② Saving  ③ Choose");
      expect(later?.props.dimColor).toBe(true);
      // Eight cells, four of them filled, wherever the block stands.
      const cells = (await ui.findAll({ type: "Text", text: /^[█░]+$/ }))
        .map((one) => one.text)
        .join("");
      expect(cells.length).toBe(8);
      expect(cells.replace(/░/g, "").length).toBe(4);
    });
  }
});

test("the writing bar moves once per second", async ($, on) => {
  const engine = world(on);
  await runFresh($, engine);

  const bar = async () => {
    let cells = "";
    await onBand($, "terminal", async (ui) => {
      cells = (await ui.findAll({ type: "Text", text: /^[█░]+$/ }))
        .map((one) => one.text)
        .join("");
    });

    return cells;
  };

  const first = await bar();
  await engine.advance(1_000);
  const second = await bar();

  expect(first).toBe("████░░░░");
  expect(second).toBe("░████░░░");
});

test("only the handoff turn is captured: not a subagent's, an earlier one or another prompt's", async ($, on) => {
  const engine = world(on);
  // A turn already running when the run starts ends after it: not ours.
  await $.turn.start({ text: "earlier", turnId: "early-1" });
  await runFresh($, engine);
  const prompt = engine.submitted[0] ?? "";
  await completeTurn($, "early-1", "earlier answer");

  // A subagent turn with the same text is ignored.
  await $.turn.start({ text: prompt, turnId: "sub-1", agentId: "a1" });
  await completeTurn($, "sub-1", "subagent text", { agentId: "a1" });

  // A task notification and a prompt the person queued run their own turns.
  await $.prompt.submit({
    text: "task done",
    wait: false,
    origin: { kind: "task-notification" },
  });
  await $.turn.start({ text: "task done", turnId: "note-1" });
  await completeTurn($, "note-1", "noted");
  await $.prompt.submit({ text: "and also", wait: false, origin: { kind: "composer" } });
  await $.turn.start({ text: "and also", turnId: "queued-1" });
  await completeTurn($, "queued-1", "queued answer");
  expect(engine.writes).toEqual([]);

  await onBand($, "terminal", async (ui) => {
    expect((await ui.find({ type: "Text", text: /Writing/ }))?.text).toBe(
      "① Writing ▕",
    );
  });

  // A main-loop turn that reuses the subagent's id is not ours either.
  await completeTurn($, "sub-1", "late subagent");
  expect(engine.writes).toEqual([]);

  await $.turn.start({ text: prompt, turnId: "handoff-1" });
  await completeTurn($, "handoff-1", HANDOFF);
  expect(engine.writes.map((one) => one.path)).toEqual([
    `${ROOT}/.claude/handoffs/.gitignore`,
    `${ROOT}/.claude/handoffs/${BASE}.md`,
  ]);
  expect(engine.writes[1]?.text.endsWith(`${HANDOFF}\n`)).toBe(true);
});

test("a handoff prompt another mod rewrote is still captured", async ($, on) => {
  const engine = world(on);
  await runFresh($, engine);
  await $.turn.start({ text: "rewritten by someone else", turnId: "h-1" });
  await completeTurn($, "h-1", HANDOFF);

  expect(engine.writes.map((one) => one.path)).toEqual([
    `${ROOT}/.claude/handoffs/.gitignore`,
    `${ROOT}/.claude/handoffs/${BASE}.md`,
  ]);
});

test("Cancel while writing ends the run; its turn is then ignored", async ($, on) => {
  const engine = world(on);

  for (const surface of SURFACES) {
    engine.reset();
    engine.store.clear();
    expect((await runFresh($, engine)).text).toBe("Writing a handoff of this chat.");
    const prompt = engine.submitted[0] ?? "";
    await $.turn.start({ text: prompt, turnId: `h-${surface}` });

    await onBand($, surface, async (ui) => {
      expect(await ui.find({ type: "Button", key: "cancel" })).toBeDefined();
      await ui.press({ key: "cancel" });
    });
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });

    await completeTurn($, `h-${surface}`, HANDOFF);
    expect(engine.writes).toEqual([]);
    expect(
      (engine.store.get("runs") as { choice: string; file: unknown }[]).map(
        (one) => [one.choice, one.file],
      ),
    ).toEqual([["cancel", null]]);

    // Not offered again in this conversation.
    await measure($, 400_000);
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }
});

test("a run whose module variables are gone keeps a way out (simulated with session.end, not a real module reload)", async ($, on) => {
  const engine = world(on);
  await runFresh($, engine);
  const prompt = engine.submitted[0] ?? "";
  // The module variables go: the turn being waited for is no longer known.
  await $.session.end({ reason: "clear", sessionId: "s1", resume: {} as never });
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  await $.turn.start({ text: prompt, turnId: "h-1" });
  await completeTurn($, "h-1", HANDOFF);
  expect(engine.writes).toEqual([]);
  expect((await runFresh($, engine)).text).toBe("A handoff is already in progress.");

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect((await ui.find({ type: "Text", text: /Writing/ }))?.text).toBe("① Writing ▕");
      expect(await ui.find({ type: "Button", key: "cancel" })).toBeDefined();
    });
  }

  await onBand($, "desktop", async (ui) => {
    await ui.press({ key: "cancel" });
  });
  await onBand($, "terminal", async (ui) => {
    expect(await ui.keepsBeneath()).toBe(true);
  });
  expect((await runFresh($, engine)).text).toBe("Writing a handoff of this chat.");
});

test("the answer is saved with its header and the self-ignoring folder; same minute gives -2", async ($, on) => {
  const engine = world(on);
  await toChoose($, engine);

  const header = `<!-- fresh-start ${new Date(START).toISOString()}, context 260000 tokens -->`;
  expect(engine.writes).toEqual([
    { path: `${ROOT}/.claude/handoffs/.gitignore`, text: "*\n" },
    {
      path: `${ROOT}/.claude/handoffs/${BASE}.md`,
      text: `${header}\n${HANDOFF}\n`,
    },
  ]);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      const saved = await ui.find({ type: "Text", text: /Saved/ });
      expect(saved?.text).toBe(`✓ Saved .claude/handoffs/${BASE}.md`);
      expect(saved?.props.color).toBe("success");
      expect(await ui.find({ type: "Button", key: "fresh" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "copy" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "cancel" })).toBeDefined();
    });
  }

  // A second run in the same minute.
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "cancel" });
  });
  await runFresh($, engine);
  await answerHandoff($, engine);
  expect(engine.writes.map((one) => one.path).slice(2)).toEqual([
    `${ROOT}/.claude/handoffs/.gitignore`,
    `${ROOT}/.claude/handoffs/${BASE}-2.md`,
  ]);

  // And a third, a minute later, starts the count again.
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "cancel" });
  });
  await engine.advance(60_000);
  await runFresh($, engine);
  await answerHandoff($, engine);
  expect(engine.writes[engine.writes.length - 1]?.path).toBe(
    `${ROOT}/.claude/handoffs/2026-11-20-1433.md`,
  );
});

test("nothing from Claude's answer reaches the path", async ($, on) => {
  const engine = world(on);
  await runFresh($, engine);
  await answerHandoff($, engine, "# Handoff: ../../etc/passwd\nbody");

  for (const write of engine.writes) {
    expect(write.path.startsWith(`${ROOT}/.claude/handoffs/`)).toBe(true);
    expect(write.path).not.toContain("passwd");
  }
});

test("an aborted or empty turn gives the failed row without Copy", async ($, on) => {
  const engine = world(on);

  for (const [answer, reason] of [
    ["partial", "aborted"],
    ["   ", "answer"],
    ["", "error"],
  ] as const) {
    engine.reset();
    await runFresh($, engine);
    await answerHandoff($, engine, answer, reason);
    expect(engine.writes).toEqual([]);

    for (const surface of SURFACES) {
      await onBand($, surface, async (ui) => {
        const error = await ui.find({ type: "Text", text: /✗/ });
        expect(error?.text).toBe("✗ Claude did not finish the handoff.");
        expect(error?.props.color).toBe("error");
        expect(await ui.find({ type: "Button", key: "copy" })).toBeUndefined();
        expect(await ui.find({ type: "Button", key: "close" })).toBeDefined();
      });
    }

    await onBand($, "terminal", async (ui) => {
      await ui.press({ key: "close" });
    });
  }
});

test("a write error gives the failed row with Copy, which still copies", async ($, on) => {
  const engine = world(on, { failWrite: "disk full" });
  await runFresh($, engine);
  await answerHandoff($, engine);

  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect((await ui.find({ type: "Text", text: /✗/ }))?.text).toBe(
        "✗ Could not save the handoff: fresh-start: $.fs.write: disk full",
      );
      expect(await ui.find({ type: "Button", key: "copy" })).toBeDefined();
    });
  }

  await onBand($, "desktop", async (ui) => {
    await ui.press({ key: "copy" });
  });
  expect(engine.copied).toEqual([{ text: HANDOFF, surface: "desktop" }]);
  // Nothing was saved, so the toast points to no file.
  expect(engine.toasts).toEqual(["Handoff copied."]);
  expect(
    (engine.store.get("runs") as { choice: string; file: unknown }[]).map(
      (one) => [one.choice, one.file],
    ),
  ).toEqual([["copy", null]]);
});

test("a second press on the same row does nothing", async ($, on) => {
  const engine = world(on);
  await toChoose($, engine);

  await onBand($, "terminal", async (ui) => {
    await Promise.all([ui.press({ key: "cancel" }), ui.press({ key: "copy" })]);
  });

  expect((engine.store.get("runs") as unknown[]).length).toBe(1);
});

test("an empty session root refuses the write", async ($, on) => {
  const engine = world(on, { root: "" });
  await runFresh($, engine);
  await answerHandoff($, engine);

  expect(engine.writes).toEqual([]);
  await onBand($, "terminal", async (ui) => {
    expect((await ui.find({ type: "Text", text: /✗/ }))?.text).toBe(
      "✗ Could not save the handoff: no project folder",
    );
  });
});

test("a dropped submit gives the failed row", async ($, on) => {
  const engine = world(on, { isSubmitDropped: true });
  await measure($, 260_000);
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "write" });
  });

  expect(engine.submitted.length).toBe(1);
  await onBand($, "terminal", async (ui) => {
    expect((await ui.find({ type: "Text", text: /✗/ }))?.text).toBe(
      "✗ Could not ask Claude for the handoff.",
    );
  });
});

test("/fresh during a run says one is in progress", async ($, on) => {
  const engine = world(on);
  expect((await runFresh($, engine)).text).toBe(
    "Writing a handoff of this chat.",
  );
  expect((await runFresh($, engine)).text).toBe(
    "A handoff is already in progress.",
  );

  await answerHandoff($, engine);
  expect((await runFresh($, engine)).text).toBe(
    "A handoff is already in progress.",
  );
  expect(engine.submitted.length).toBe(1);
});

test("Start fresh runs clear, then fills the box with the text", async ($, on) => {
  const engine = world(on);

  for (const surface of SURFACES) {
    engine.reset();
    await toChoose($, engine);
    await onBand($, surface, async (ui) => {
      await ui.press({ key: "fresh" });
    });

    expect(engine.calls).toEqual(["command:clear", "fill"]);
    expect(engine.filled).toEqual([HANDOFF]);
    expect(engine.toasts).toEqual([]);
    // Never submitted into the new chat: only the handoff prompt went out.
    expect(engine.submitted.length).toBe(1);

    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }
});

test("the text crosses the session end of /clear", async ($, on) => {
  // The host's /clear ends the conversation inside the command's run.
  const engine = world(on, {
    onClear: () =>
      $.session.end({ reason: "clear", sessionId: "s1", resume: {} as never }),
  });
  await toChoose($, engine);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "fresh" });
  });

  expect(engine.commands).toEqual(["clear"]);
  expect(engine.filled).toEqual([HANDOFF]);
});

test("a refused fill falls back to copy and a toast", async ($, on) => {
  const engine = world(on, { isFillRefused: true });
  await toChoose($, engine);

  await onBand($, "desktop", async (ui) => {
    await ui.press({ key: "fresh" });
  });

  expect(engine.commands).toEqual(["clear"]);
  expect(engine.copied).toEqual([{ text: HANDOFF, surface: "desktop" }]);
  expect(engine.toasts).toEqual([
    `Handoff saved in .claude/handoffs/${BASE}.md. Paste it from there.`,
  ]);
});

test("Copy uses the press surface and says it copied", async ($, on) => {
  const engine = world(on);

  for (const surface of SURFACES) {
    engine.reset();
    await runFresh($, engine);
    await answerHandoff($, engine);
    await onBand($, surface, async (ui) => {
      await ui.press({ key: "copy" });
    });
    expect(engine.copied).toEqual([{ text: HANDOFF, surface }]);
    expect(engine.toasts).toEqual([
      expect.stringMatching(
        /^Handoff copied\. Saved in \.claude\/handoffs\/2026-11-20-1432(-2)?\.md\.$/,
      ),
    ]);
    expect(engine.commands).toEqual([]);

    // The row is gone and the offer does not come back at the next measure.
    await measure($, 400_000);
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }

  expect(engine.toasts).toEqual([
    `Handoff copied. Saved in .claude/handoffs/${BASE}-2.md.`,
  ]);
});

test("a copy the surface refuses says where the file is", async ($, on) => {
  const engine = world(on, { isCopied: false });
  await runFresh($, engine);
  await answerHandoff($, engine);
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "copy" });
  });

  expect(engine.copied).toEqual([{ text: HANDOFF, surface: "terminal" }]);
  expect(engine.toasts).toEqual([
    `Could not copy. The handoff is in .claude/handoffs/${BASE}.md.`,
  ]);
});

test("Cancel ends the run and keeps the file", async ($, on) => {
  const engine = world(on);
  await toChoose($, engine);

  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "cancel" });
  });

  expect(engine.commands).toEqual([]);
  expect(engine.copied).toEqual([]);
  expect(engine.store.get("runs")).toEqual([
    {
      at: new Date(START).toISOString(),
      tokens: 260_000,
      file: `.claude/handoffs/${BASE}.md`,
      choice: "cancel",
    },
  ]);

  await onBand($, "terminal", async (ui) => {
    expect(await ui.keepsBeneath()).toBe(true);
  });
});

test("the run log keeps the last 20 and never the text", async ($, on) => {
  const old = Array.from({ length: 20 }, (_, index) => ({
    at: new Date(START - (20 - index) * 60_000).toISOString(),
    tokens: 1,
    file: null,
    choice: "cancel",
  }));
  const engine = world(on, { runs: old });
  await toChoose($, engine);
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "fresh" });
  });

  const runs = engine.store.get("runs") as Record<string, unknown>[];
  expect(runs.length).toBe(20);
  expect(runs[0]).toEqual(old[1]);
  expect(runs[19]).toEqual({
    at: new Date(START).toISOString(),
    tokens: 260_000,
    file: `.claude/handoffs/${BASE}.md`,
    choice: "fresh",
  });
  expect(JSON.stringify(runs)).not.toContain("Handoff");
  expect(JSON.stringify(runs)).not.toContain("importer");
});

test("a failed run closed logs failed", async ($, on) => {
  const engine = world(on);
  await runFresh($, engine);
  await answerHandoff($, engine, "", "aborted");
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "close" });
  });

  expect(
    (engine.store.get("runs") as { choice: string }[]).map((one) => one.choice),
  ).toEqual(["failed"]);
});

test("a later session.start keeps the run's state", async ($, on) => {
  const engine = world(on);
  await toChoose($, engine);
  await $.session.start({
    cwd: ROOT,
    surface: "terminal",
    isInteractive: true,
  });

  await onBand($, "terminal", async (ui) => {
    expect((await ui.find({ type: "Text", text: /Saved/ }))?.text).toBe(
      `✓ Saved .claude/handoffs/${BASE}.md`,
    );
  });
});

test("a survey keeps the band for the engine", async ($, on) => {
  world(on);
  await measure($, 260_000);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      ...BAND,
      props: { ...BAND.props, hasSurvey: true },
      surface,
    });
    expect(await ui.keepsBeneath()).toBe(true);
    await ui.unmount();
  }
});

test("hooks pass every event on unchanged", async ($, on) => {
  const engine = world(on);

  expect(
    await $.session.start({
      cwd: ROOT,
      surface: "terminal",
      isInteractive: true,
    }),
  ).toEqual({ cwd: ROOT });
  expect(await measure($, 260_000)).toEqual({ changed: ["context"] });
  expect(await $.turn.start({ text: "hi", turnId: "t1" })).toEqual({
    turnId: "t1",
  });
  expect(await completeTurn($, "t1", "an answer")).toMatchObject({
    text: "an answer",
  });
  expect(
    await $.turn.start({ text: "go", turnId: "t2", agentId: "a1" }),
  ).toEqual({
    turnId: "t2",
  });

  expect(
    await $.prompt.submit({ text: "hi", wait: false, origin: { kind: "composer" } }),
  ).toMatchObject({ text: "hi" });

  // The handoff turn itself is observed, never rewritten.
  await runFresh($, engine);
  const prompt = engine.submitted[0] ?? "";
  expect(await $.turn.start({ text: prompt, turnId: "h1" })).toEqual({
    turnId: "h1",
  });
  expect(await completeTurn($, "h1", HANDOFF)).toMatchObject({ text: HANDOFF });

  // Another command goes to the engine untouched.
  expect(await $.command.run({ ...FRESH, command: "help" })).toEqual({
    text: "",
  });
  expect(engine.commands).toEqual(["help"]);

  expect(
    await $.session.end({
      reason: "clear",
      sessionId: "s1",
      resume: {} as never,
    }),
  ).toEqual({ sessionId: "s1" });
});

test("a failing $ call inside a hook still passes the event on", async ($, on) => {
  // Nothing beneath for the state's neighbours: the mod's own calls fail.
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));

  expect(await measure($, 260_000)).toEqual({ changed: ["context"] });
  expect(await completeTurn($, "t1", "x")).toMatchObject({ text: "x" });
  expect(
    await $.session.start({
      cwd: ROOT,
      surface: "terminal",
      isInteractive: true,
    }),
  ).toEqual({ cwd: ROOT });
});

test("a measure landing during Copy does not bring the offer back", async ($, on) => {
  // Whether the row was drawn right after that measure, before the copy ended.
  const drawnDuringCopy: boolean[] = [];
  const engine = world(on, {
    onCopy: async () => {
      await measure($, 500_000);

      const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
      drawnDuringCopy.push(!(await ui.keepsBeneath()));
      await ui.unmount();
    },
  });
  await toChoose($, engine);
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "copy" });
  });

  expect(drawnDuringCopy).toEqual([false]);
  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
  }
});

test("a /fresh started during Copy is not undone when the copy ends", async ($, on) => {
  let isFreshDuringCopy = true;
  const engine = world(on, {
    onCopy: async () => {
      if (isFreshDuringCopy) {
        isFreshDuringCopy = false;
        await $.command.run(FRESH);
      }
    },
  });
  await toChoose($, engine);
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "copy" });
  });
  await engine.advance(0);

  expect(engine.submitted.length).toBe(2);
  for (const surface of SURFACES) {
    await onBand($, surface, async (ui) => {
      expect((await ui.find({ type: "Text", text: /Writing/ }))?.text).toBe("① Writing ▕");
    });
  }

  // The newer run still captures its own turn.
  await $.turn.start({ text: engine.submitted[1] ?? "", turnId: "h-2" });
  await completeTurn($, "h-2", HANDOFF);
  expect(engine.writes[engine.writes.length - 1]?.path).toBe(
    `${ROOT}/.claude/handoffs/${BASE}-2.md`,
  );
});

test("a queued slash or skill command's turn is skipped before ours", async ($, on) => {
  const engine = world(on);
  await runFresh($, engine);
  const prompt = engine.submitted[0] ?? "";
  await $.prompt.submit({
    text: "/review",
    wait: false,
    origin: { kind: "composer" },
    command: { name: "review", args: "" },
  });
  // The skill's turn carries its rendered body, which no prompt showed.
  await $.turn.start({ text: "Review the open changes and ...", turnId: "skill-1" });
  await completeTurn($, "skill-1", "review done");
  expect(engine.writes).toEqual([]);

  await $.turn.start({ text: prompt, turnId: "h-1" });
  await completeTurn($, "h-1", HANDOFF);
  expect(engine.writes.map((one) => one.path)).toEqual([
    `${ROOT}/.claude/handoffs/.gitignore`,
    `${ROOT}/.claude/handoffs/${BASE}.md`,
  ]);
});

test("a continuation turn with no text is never the handoff turn", async ($, on) => {
  const engine = world(on);
  await runFresh($, engine);
  await $.turn.start({ text: "", turnId: "cont-1" });
  await completeTurn($, "cont-1", "continued");
  expect(engine.writes).toEqual([]);

  await $.turn.start({ text: engine.submitted[0] ?? "", turnId: "h-1" });
  await completeTurn($, "h-1", HANDOFF);
  expect(engine.writes.length).toBe(2);
});

test("the person's own /clear drops the handoff text from memory", async ($, on) => {
  const engine = world(on);
  await toChoose($, engine);
  await $.session.end({ reason: "clear", sessionId: "s1", resume: {} as never });

  // The kit keeps the state through the clear; the text is gone all the same.
  await onBand($, "terminal", async (ui) => {
    await ui.press({ key: "copy" });
  });
  expect(engine.copied).toEqual([]);
  expect(engine.toasts).toEqual([
    `Could not copy. The handoff is in .claude/handoffs/${BASE}.md.`,
  ]);
});

test("Cancel while saving ends the run; the row does not move on to choose", async ($, on) => {
  let surface: (typeof SURFACES)[number] = "terminal";
  // Whether the saving row offered Cancel, per round.
  const hadCancel: boolean[] = [];
  const engine = world(on, {
    onWrite: async () => {
      const ui = await $.ui.mount({ ...BAND, surface });
      const step = await ui.find({ type: "Text", text: /Saving/ });
      hadCancel.push(
        step?.text === "  ② Saving" &&
          (await ui.find({ type: "Button", key: "cancel" })) !== undefined,
      );
      await ui.press({ key: "cancel" });
      await ui.unmount();
    },
  });

  for (const round of SURFACES) {
    surface = round;
    engine.reset();
    engine.store.clear();
    await runFresh($, engine);
    await answerHandoff($, engine);

    await onBand($, round, async (ui) => {
      expect(await ui.keepsBeneath()).toBe(true);
    });
    expect(
      (engine.store.get("runs") as { choice: string }[]).map((one) => one.choice),
    ).toEqual(["cancel"]);
  }

  expect(hadCancel).toEqual([true, true]);
});

// Amendment 2: from 100 band columns the row keeps to floor((columns - 1) / 2).

/** Mounts the row at a band width, runs the body, unmounts. */
const onBandAt = async (
  $: Engine,
  surface: (typeof SURFACES)[number],
  bodyColumns: number,
  body: (
    ui: Mounted<(typeof SURFACES)[number], "AbovePrompt">,
  ) => Promise<void>,
) => {
  const ui = await $.ui.mount({
    ...BAND,
    surface,
    props: { ...BAND.props, bodyColumns },
  });
  await body(ui);
  await ui.unmount();
};

const rowWidth = async (
  ui: Mounted<(typeof SURFACES)[number], "AbovePrompt">,
): Promise<unknown> => {
  const drawn = await ui.drawn();

  return drawn.type === "Box" ? drawn.props?.width : undefined;
};

test("the offer is compact at half of 120 columns and whole at 80, on every surface", async ($, on) => {
  world(on);
  await measure($, 252_400);

  for (const surface of SURFACES) {
    await onBandAt($, surface, 120, async (ui) => {
      expect(await rowWidth(ui)).toBe(59);
      expect((await ui.find({ type: "Text", text: /tokens/ }))?.text).toBe(
        "◆ Chat at 252k tokens.",
      );
      expect(await ui.find({ type: "Button", key: "write" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "not-now" })).toBeDefined();
    });
    await onBandAt($, surface, 80, async (ui) => {
      expect(await rowWidth(ui)).toBe(80);
      expect((await ui.find({ type: "Text", text: /tokens/ }))?.text).toBe(
        "◆ This chat is at 252k tokens.",
      );
    });
  }
});

test("the writing strip keeps bar and time at half width; labels shorten only when needed", async ($, on) => {
  const engine = world(on);
  await runFresh($, engine);
  await engine.advance(42_000);

  for (const surface of SURFACES) {
    // 59 columns: the whole strip fits.
    await onBandAt($, surface, 120, async (ui) => {
      expect(await rowWidth(ui)).toBe(59);
      expect((await ui.find({ type: "Text", text: /①/ }))?.text).toBe(
        "① Writing ▕",
      );
      expect((await ui.find({ type: "Text", text: /②/ }))?.text).toBe(
        "  ② Saving  ③ Choose",
      );
      expect((await ui.find({ type: "Text", text: /0:42/ }))?.text).toBe(
        "▏ 0:42",
      );
      expect(await ui.find({ type: "Button", key: "cancel" })).toBeDefined();
    });
    // 49 columns: the step labels give way, bar and time stay.
    await onBandAt($, surface, 100, async (ui) => {
      expect(await rowWidth(ui)).toBe(49);
      expect((await ui.find({ type: "Text", text: /①/ }))?.text).toBe("① ▕");
      expect((await ui.find({ type: "Text", text: /②/ }))?.text).toBe("  ② ③");
      expect((await ui.find({ type: "Text", text: /0:42/ }))?.text).toBe(
        "▏ 0:42",
      );
      const cells = (await ui.findAll({ type: "Text", text: /^[█░]+$/ }))
        .map((one) => one.text)
        .join("");
      expect(cells.length).toBe(8);
      expect(await ui.find({ type: "Button", key: "cancel" })).toBeDefined();
    });
    await onBandAt($, surface, 80, async (ui) => {
      expect(await rowWidth(ui)).toBe(80);
      expect((await ui.find({ type: "Text", text: /①/ }))?.text).toBe(
        "① Writing ▕",
      );
    });
  }
});

test("the choose row shows only the file name at half width, the path at 80", async ($, on) => {
  const engine = world(on);
  await toChoose($, engine);

  for (const surface of SURFACES) {
    await onBandAt($, surface, 120, async (ui) => {
      // 59 columns less the three buttons (41) and 1 of slack leaves 17.
      const saved = await ui.find({ type: "Text", text: /✓/ });
      expect(saved?.text).toBe(`✓ ${BASE.slice(0, -1)}…`);
      expect(saved?.text.length).toBe(17);
      expect(saved?.props.color).toBe("success");
      expect(await ui.find({ type: "Button", key: "fresh" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "copy" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "cancel" })).toBeDefined();
    });
    await onBandAt($, surface, 160, async (ui) => {
      // 79 columns: the whole name fits, never its folder.
      expect((await ui.find({ type: "Text", text: /✓/ }))?.text).toBe(
        `✓ ${BASE}.md`,
      );
    });
    await onBandAt($, surface, 80, async (ui) => {
      expect((await ui.find({ type: "Text", text: /✓/ }))?.text).toBe(
        `✓ Saved .claude/handoffs/${BASE}.md`,
      );
    });
  }
});

test("the failed row clips its error at half width; the buttons stay whole", async ($, on) => {
  const engine = world(on, { failWrite: "disk full" });
  await runFresh($, engine);
  await answerHandoff($, engine);
  const error =
    "✗ Could not save the handoff: fresh-start: $.fs.write: disk full";

  for (const surface of SURFACES) {
    await onBandAt($, surface, 120, async (ui) => {
      // 59 columns less Copy (9), Close (10) and 1 of slack leaves 39.
      const shown = await ui.find({ type: "Text", text: /✗/ });
      expect(shown?.text).toBe(`${error.slice(0, 38)}…`);
      expect(shown?.props.color).toBe("error");
      expect(await ui.find({ type: "Button", key: "copy" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "close" })).toBeDefined();
    });
    await onBandAt($, surface, 80, async (ui) => {
      expect((await ui.find({ type: "Text", text: /✗/ }))?.text).toBe(error);
    });
  }
});
