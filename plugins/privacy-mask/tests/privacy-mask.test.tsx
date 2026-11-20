// UI and command tests of privacy-mask. All personal details here are made up.
import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On, RenderComponent, RenderPropsOf } from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;
type Surface = (typeof SURFACES)[number];

const BAR = "██████";
const NAMES = ["Piet Jansen"];
const OPTIONS = { options: { names: NAMES } };
const SAMPLE = "Piet Jansen, piet@example.nl, 06-12345678";
const MASKED = `${BAR}, ${BAR}, ${BAR}`;
const PLACEHOLDER = "█ masked content could not be drawn";

const MASK = {
  command: "mask",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 120 },
} as const;

const BASH_OUTPUT = {
  stdout: `found ${SAMPLE}`,
  stderr: "API_KEY=abc123",
  interrupted: false,
};

/** The props each hooked component is drawn with: a sample in every text. */
const PROPS = {
  UserMessage: { text: SAMPLE, origin: { kind: "composer" }, isExpanded: true },
  AssistantMessage: { text: SAMPLE, isFirstOfReply: true },
  ToolUse: {
    tool_use_id: "toolu_1",
    tool: "Bash",
    input: { command: `grep "${SAMPLE}" crm.csv`, timeout: 1000 },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: BASH_OUTPUT,
  },
  ToolResult: {
    tool_use_id: "toolu_1",
    tool: "Bash",
    output: BASH_OUTPUT,
    isErrored: false,
  },
  ToolGroup: {
    calls: [
      {
        tool: "Read",
        input: { file_path: "/work/a.txt" },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      },
    ],
    isActive: false,
    isExpanded: false,
  },
  CommandOutput: { command: "notes", args: "", text: SAMPLE, isErrored: false },
  InfoNotice: { text: SAMPLE, command: null },
  AgentRow: {
    id: "agent_1",
    description: "Look up a customer",
    type: "general-purpose",
    status: "running",
    kind: "local_agent",
    taskStatus: "running",
    label: SAMPLE,
    startTime: 0,
    cwd: "/work",
    tokenCount: 0,
    tokenSamples: [],
    hasRow: true,
    rowIds: ["agent_1"],
    isHidden: false,
    body: SAMPLE,
  },
  Spinner: { word: "Working", message: SAMPLE, suffix: "…", mode: "tool-use" },
} satisfies { [C in RenderComponent]?: RenderPropsOf[C] };

type Hooked = keyof typeof PROPS;

/** What a masked drawing of each component must hand the engine. */
const EXPECTED_ON: { [C in Hooked]: Record<string, unknown> } = {
  UserMessage: { text: MASKED },
  AssistantMessage: { text: MASKED },
  ToolUse: {
    input: { command: `grep "${MASKED}" crm.csv`, timeout: 1000 },
    output: {
      stdout: `found ${MASKED}`,
      stderr: `API_KEY=${BAR}`,
      interrupted: false,
    },
  },
  ToolResult: {
    output: {
      stdout: `found ${MASKED}`,
      stderr: `API_KEY=${BAR}`,
      interrupted: false,
    },
  },
  ToolGroup: { isExpanded: true },
  CommandOutput: { text: MASKED },
  InfoNotice: { text: MASKED },
  AgentRow: { label: MASKED, body: MASKED },
  Spinner: { word: "Working", message: MASKED },
};

// InfoNotice is raised on the terminal alone.
const SURFACES_OF: { [C in Hooked]?: readonly Surface[] } = {
  InfoNotice: ["terminal"],
};

/**
 * Stands in for the engine beneath the mod and records the props each
 * component reached it with, by component.
 */
const world = (on: On, registered: string[] = []): Map<string, unknown[]> => {
  const seen = new Map<string, unknown[]>();
  on("command.register", (_, e) => {
    registered.push(e.name);

    return { value: { command: e.name } };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("ui.render", (_, e, next) => {
    seen.set(e.component, [...(seen.get(e.component) ?? []), e.props]);

    return next(e);
  });

  return seen;
};

const startSession = ($: Engine) =>
  $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });

/** Draws one component and answers the props that reached the engine. */
const drawn = async <C extends Hooked>(
  $: Engine,
  seen: Map<string, unknown[]>,
  surface: Surface,
  component: C,
  props: RenderPropsOf[C] = PROPS[component] as RenderPropsOf[C],
): Promise<unknown> => {
  seen.delete(component);
  const ui = await $.ui.mount({
    plugin: "privacy-mask",
    surface,
    component,
    props,
  });
  await ui.unmount();

  return seen.get(component)?.at(-1);
};

const hooked = Object.keys(PROPS) as Hooked[];

test(
  "while off, every hooked component reaches the engine untouched",
  OPTIONS,
  async ($, on) => {
    const seen = world(on);
    await startSession($);

    for (const component of hooked) {
      for (const surface of SURFACES_OF[component] ?? SURFACES) {
        expect(await drawn($, seen, surface, component)).toEqual(
          PROPS[component],
        );
      }
    }
  },
);

test(
  "while on, every hooked component's text is masked on both surfaces",
  OPTIONS,
  async ($, on) => {
    const seen = world(on);
    await startSession($);
    await $.command.run(MASK);

    for (const component of hooked) {
      for (const surface of SURFACES_OF[component] ?? SURFACES) {
        expect(await drawn($, seen, surface, component)).toEqual({
          ...PROPS[component],
          ...EXPECTED_ON[component],
        });
      }
    }
  },
);

test(
  "a ToolResult rewrite keeps the Bash output shape",
  OPTIONS,
  async ($, on) => {
    const seen = world(on);
    await startSession($);
    await $.command.run(MASK);
    const output = {
      ...BASH_OUTPUT,
      isImage: false,
      timedOutAfterMs: 120000,
      bashEditDiff: {
        files: [
          {
            filePath: "/work/.env",
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-DB_PASS=old1", "+DB_PASS=new2"],
              },
            ],
          },
        ],
        moreFiles: 0,
      },
    };

    for (const surface of SURFACES) {
      const props = (await drawn($, seen, surface, "ToolResult", {
        ...PROPS.ToolResult,
        output,
      })) as {
        output: typeof output;
      };

      expect(Object.keys(props.output)).toEqual(Object.keys(output));
      expect(props.output).toEqual({
        ...output,
        stdout: `found ${MASKED}`,
        stderr: `API_KEY=${BAR}`,
        bashEditDiff: {
          ...output.bashEditDiff,
          files: [
            {
              filePath: "/work/.env",
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: [`-DB_PASS=${BAR}`, `+DB_PASS=${BAR}`],
                },
              ],
            },
          ],
        },
      });
    }
  },
);

test(
  "an empty or masked-free text is drawn as it is while on",
  OPTIONS,
  async ($, on) => {
    const seen = world(on);
    await startSession($);
    await $.command.run(MASK);

    for (const surface of SURFACES) {
      const props = { ...PROPS.AssistantMessage, text: "All tests pass." };
      expect(await drawn($, seen, surface, "AssistantMessage", props)).toEqual(
        props,
      );
    }
  },
);

/** A tool input nested past what the mod trusts itself to mask. */
const deepInput = (): Record<string, unknown> => {
  let value: Record<string, unknown> = { secret: SAMPLE };

  for (let i = 0; i < 40; i++) {
    value = { inner: value };
  }

  return value;
};

test(
  "a mask that throws while on draws the placeholder, never the row",
  OPTIONS,
  async ($, on) => {
    const seen = world(on);
    await startSession($);
    await $.command.run(MASK);

    for (const surface of SURFACES) {
      seen.delete("ToolUse");
      const ui = await $.ui.mount({
        plugin: "privacy-mask",
        surface,
        component: "ToolUse",
        props: { ...PROPS.ToolUse, input: deepInput() },
      });

      expect((await ui.find({ type: "Text", text: PLACEHOLDER }))?.text).toBe(
        PLACEHOLDER,
      );
      expect(await ui.find({ text: "Piet" })).toBeUndefined();
      // Nothing of the row reached the engine to draw.
      expect(seen.get("ToolUse")).toBeUndefined();
      await ui.unmount();
    }
  },
);

test(
  "the same input while off is passed on untouched",
  OPTIONS,
  async ($, on) => {
    const seen = world(on);
    await startSession($);
    const props = { ...PROPS.ToolUse, input: deepInput() };

    for (const surface of SURFACES) {
      expect(await drawn($, seen, surface, "ToolUse", props)).toEqual(props);
    }
  },
);

test(
  "/mask toggles with its replies, for the person alone",
  OPTIONS,
  async ($, on) => {
    world(on);
    await startSession($);

    expect(await $.command.run(MASK)).toEqual({
      text: "Masking is on. Rows printed before now may still show unmasked.",
      isTextDisplayOnly: true,
    });
    expect(await $.command.run(MASK)).toEqual({
      text: "Masking is off.",
      isTextDisplayOnly: true,
    });
    expect((await $.command.run(MASK)).text).toMatch(/^Masking is on\./);
  },
);

test(
  "the masked label shows in the footer only while on",
  OPTIONS,
  async ($, on) => {
    const seen = world(on);
    await startSession($);
    const footer = async (surface: Surface): Promise<unknown> => {
      seen.delete("SessionMode");
      const ui = await $.ui.mount({
        plugin: "privacy-mask",
        surface,
        component: "SessionMode",
        props: { modes: ["focus"] },
      });
      await ui.unmount();

      const props = seen.get("SessionMode")?.at(-1) as
        | { modes: readonly string[] }
        | undefined;

      return props?.modes;
    };

    for (const surface of SURFACES) {
      expect(await footer(surface)).toEqual(["focus"]);
    }

    await $.command.run(MASK);

    for (const surface of SURFACES) {
      expect(await footer(surface)).toEqual(["focus", "masked"]);
    }

    await $.command.run(MASK);

    for (const surface of SURFACES) {
      expect(await footer(surface)).toEqual(["focus"]);
    }
  },
);

test(
  "the switch survives a later session.start and a /clear",
  OPTIONS,
  async ($, on) => {
    const seen = world(on);
    await startSession($);
    await $.command.run(MASK);

    // A reload raises session.start again; a /clear raises session.end.
    await startSession($);
    await $.session.end({
      reason: "clear",
      sessionId: "s1",
      resume: { id: "s1" },
    });

    for (const surface of SURFACES) {
      expect(await drawn($, seen, surface, "UserMessage")).toEqual({
        ...PROPS.UserMessage,
        text: MASKED,
      });
    }
  },
);

test(
  "hooks pass session events on unchanged and register /mask",
  OPTIONS,
  async ($, on) => {
    const registered: string[] = [];
    world(on, registered);

    expect(await startSession($)).toEqual({ cwd: "/work" });
    expect(registered).toEqual(["mask"]);
  },
);
