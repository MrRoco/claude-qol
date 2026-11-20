import { atom, read, update } from "claude-code";
import type {
  EngineInterface,
  PromptSubmitInput,
  Register,
  Timer,
} from "claude-code";

import type { AgentCard, Task, TaskStatus } from "../types";

const PANE_ID = "task-bar-crew";
const PANE_TITLE = "Crew";

// The bar above the prompt fills its row, never narrower than this.
const MIN_BAR_CELLS = 10;
const CARD_BAR_CELLS = 12;
const TICK_MS = 1000;

// Theme keys, never fixed colours, so the row follows the person's theme.
// The theme table has no key literally named `accent` or `danger`: `claude` is
// the theme's own accent colour and `error` its danger colour.
const ACCENT = "claude";
const SUCCESS = "success";
const DANGER = "error";

// The own progress tool, registered only where the built-in to-do tools are
// missing. The engine names it mcp__<plugin>__<name>.
const PROGRESS_NAME = "progress";
const PROGRESS_TOOL = "mcp__task-bar__progress";
const PROGRESS_DESCRIPTION =
  "Show the person how far you are with a task of three or more steps. " +
  "Send the whole list every time, in order, each item with its state. " +
  "Call it when you start, and again each time an item starts or finishes.";
const PROGRESS_SCHEMA = {
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
};
const PROGRESS_ERROR = "progress: items must be a list of { label, state }";
const PROGRESS_STATUS: Readonly<Record<string, TaskStatus>> = {
  todo: "pending",
  doing: "in_progress",
  done: "completed",
};

// The only two texts the mod ever sends the model, under the contract's rules.
const REMINDER_START =
  "task-bar: this looks like a multi-step task. If it has three or more steps, send them with the progress tool so the person can follow along.";
const REMINDER_STALE =
  "task-bar: the progress list has not changed for a while. If an item started or finished, send the updated list with the progress tool.";
const START_REMINDER_CALL = 4;
const REMINDER_SPACING = 8;

// Prompts the person sent: typed at the terminal, through Remote Control, by
// an SDK host such as the desktop app, or their own ping from Slack. A
// background task's notification, a plugin's prompt, a peer or a continuation
// is no prompt of the person's.
const PERSON_ORIGINS: readonly string[] = [
  "composer",
  "bridge",
  "sdk",
  "slack-ping",
];

const tasksAtom = atom({ plugin: "task-bar", key: "tasks" } as const, []);
const goalAtom = atom({ plugin: "task-bar", key: "goal" } as const, null);
const agentsAtom = atom({ plugin: "task-bar", key: "agents" } as const, []);
const paneClosedAtom = atom(
  { plugin: "task-bar", key: "paneClosedByUser" } as const,
  false,
);

type Engine = EngineInterface;

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTaskStatus = (value: unknown): value is TaskStatus =>
  typeof value === "string" &&
  (TASK_STATUSES as readonly string[]).includes(value);

/**
 * Reads a TodoWrite list into tasks; undefined when it is not a well-formed
 * list, so the caller keeps the last good state.
 */
const parseTodos = (value: unknown): Task[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tasks: Task[] = [];

  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      typeof item.content !== "string" ||
      !isTaskStatus(item.status)
    ) {
      return undefined;
    }

    tasks.push({
      id: String(index),
      title: item.content,
      ...(typeof item.activeForm === "string" && item.activeForm !== ""
        ? { activeTitle: item.activeForm }
        : {}),
      status: item.status,
    });
  }

  return tasks;
};

const isAllDone = (tasks: readonly Task[]): boolean =>
  tasks.length > 0 && tasks.every((task) => task.status === "completed");

const countDone = (tasks: readonly Task[]): number =>
  tasks.filter((task) => task.status === "completed").length;

/** What Claude is doing now: the first in-progress task, else the next pending one. */
const currentText = (tasks: readonly Task[]): string => {
  const active = tasks.find((task) => task.status === "in_progress");

  if (active !== undefined) {
    return active.activeTitle ?? active.title;
  }

  return tasks.find((task) => task.status === "pending")?.title ?? "";
};

const clip = (text: string, room: number): string => {
  if (room <= 0) {
    return "";
  }

  return text.length <= room
    ? text
    : `${text.slice(0, Math.max(0, room - 1))}…`;
};

/**
 * Reads a progress call into the goal and tasks; undefined when the items are
 * not a list of { label, state }, so the caller keeps the last good state.
 */
const parseProgress = (
  input: unknown,
): { goal: string | null; tasks: Task[] } | undefined => {
  if (!isRecord(input) || !Array.isArray(input.items)) {
    return undefined;
  }

  const tasks: Task[] = [];

  for (const [index, item] of input.items.entries()) {
    const status = isRecord(item) && typeof item.state === "string"
      ? PROGRESS_STATUS[item.state]
      : undefined;

    if (!isRecord(item) || typeof item.label !== "string" || status === undefined) {
      return undefined;
    }

    tasks.push({
      id: String(index),
      title: item.label,
      activeTitle: item.label,
      status,
    });
  }

  const goal =
    typeof input.goal === "string" && input.goal.trim() !== ""
      ? input.goal.trim()
      : null;

  return { goal, tasks };
};

const isPersonPrompt = (e: PromptSubmitInput): boolean =>
  e.isMeta !== true &&
  e.command === undefined &&
  PERSON_ORIGINS.includes(e.origin.kind);

const filledCells = (done: number, total: number, width: number): number =>
  total <= 0 ? 0 : Math.min(width, Math.round((done / total) * width));

const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
};

// The ticker lives in the module: nothing is drawn from it, and a reload stops it.
let ticker: Timer | undefined;
let hasAutoOpened = false;
// Whether the Crew pane is open, as far as this copy of the module has seen.
let isPaneOpen = false;
// Whether this load registered the progress tool; reminders only then.
let isToolRegistered = false;
// Bumped by every main-loop progress call, so a reminder decided while it
// landed is dropped.
let progressEpoch = 0;
// Main-loop tool calls this turn, for the reminders; reset at every prompt.
let callsThisTurn = 0;
let callsSinceProgress = 0;
let callsSinceReminder = REMINDER_SPACING;
let isListDoneThisTurn = false;
let hasStartReminderThisTurn = false;
// Bumped at every prompt, so a call still waiting from an earlier turn
// cannot place a reminder in the new one.
let turnEpoch = 0;

// The tool calls the main loop's own responses asked for, by tool_use id,
// from the rows its conversation keeps before the tools run. Only a call found
// here counts toward a reminder or gets one: PostToolUse may carry no
// `agent_id` for a subagent's call, and a reminder must never reach a subagent.
const mainLoopToolUses = new Set<string>();

const resetCounters = (): void => {
  callsThisTurn = 0;
  callsSinceProgress = 0;
  callsSinceReminder = REMINDER_SPACING;
  isListDoneThisTurn = false;
  hasStartReminderThisTurn = false;
  turnEpoch += 1;
  mainLoopToolUses.clear();
};

const stopTicker = (): void => {
  ticker?.cancel();
  ticker = undefined;
};

/** Runs state work so that a failure never reaches the tool call or turn. */
const safely = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch {
    // Observe only: a failed update keeps the last good state and the event
    // goes on untouched. Nothing is logged, as titles may hold client names.
  }
};

const resetAll = async ($: Engine): Promise<void> => {
  stopTicker();
  hasAutoOpened = false;
  isPaneOpen = false;
  mainLoopToolUses.clear();
  await update($, tasksAtom, () => []);
  await update($, goalAtom, () => null);
  await update($, agentsAtom, () => []);
  await update($, paneClosedAtom, () => false);
};

/**
 * Ticks the elapsed time once a second while the Crew pane is open and any
 * card runs, and stops otherwise.
 */
const syncTicker = ($: Engine, agents: readonly AgentCard[]): void => {
  const shouldTick =
    isPaneOpen && agents.some((card) => card.status === "running");

  if (shouldTick && ticker === undefined) {
    ticker = $.clock.every(TICK_MS, () => $.ui.invalidate("ui.render"));
  } else if (!shouldTick && ticker !== undefined) {
    ticker.cancel();
    ticker = undefined;
  }
};

/**
 * Counts one main-loop tool call and says which reminder, if any, goes with
 * it: the start one at the 4th call of a turn with no list, the stale one 8
 * calls after the last progress call while items are open; at most one per
 * 8 calls, none once the list was all done this turn.
 */
const nextReminder = async ($: Engine): Promise<string | undefined> => {
  // PostToolUse hooks of one batch run side by side, so this call takes its
  // own copy of the counts before any await, and the choice below is made in
  // one synchronous step after it.
  callsThisTurn += 1;
  callsSinceProgress += 1;
  callsSinceReminder += 1;
  const call = callsThisTurn;
  const epoch = turnEpoch;
  const progressSeen = progressEpoch;

  if (isListDoneThisTurn || callsSinceReminder < REMINDER_SPACING) {
    return undefined;
  }

  let tasks: Task[];

  try {
    tasks = await read($, tasksAtom);
  } catch {
    return undefined;
  }

  // Another call of the batch may have reminded, a progress call may have
  // landed, or a prompt started a new turn, while this one waited: check
  // again, then decide without awaiting.
  if (
    epoch !== turnEpoch ||
    progressSeen !== progressEpoch ||
    isListDoneThisTurn ||
    callsSinceReminder < REMINDER_SPACING
  ) {
    return undefined;
  }

  // The call that crossed the 4th of the turn, by its own count: exactly one
  // per turn, whichever of a batch gets here first.
  const reminder =
    tasks.length === 0 && call >= START_REMINDER_CALL && !hasStartReminderThisTurn
      ? REMINDER_START
      : tasks.length > 0 &&
          !isAllDone(tasks) &&
          callsSinceProgress >= REMINDER_SPACING
        ? REMINDER_STALE
        : undefined;

  if (reminder === REMINDER_START) {
    hasStartReminderThisTurn = true;
  }

  if (reminder !== undefined) {
    callsSinceReminder = 0;
  }

  return reminder;
};

/**
 * Takes in one finished tool call: a main-loop one counts toward the
 * reminders, and the reminder due with it, if any, is returned. Only a call
 * the main loop's own response asked for counts; a subagent's is counted from
 * its tool-result row, and the progress call where it is answered.
 */
const afterToolCall = async (
  $: Engine,
  tool: string,
  agentId: string | undefined,
  toolUseId: string,
): Promise<string | undefined> => {
  const isMainLoop = mainLoopToolUses.delete(toolUseId);

  if (tool === PROGRESS_TOOL || agentId !== undefined || !isMainLoop) {
    return undefined;
  }

  return isToolRegistered ? nextReminder($) : undefined;
};

/**
 * Answers a progress call: a subagent's fills its card, the main loop's fills
 * the bar. Served at `tool.call` under a RegExp matcher: a `tool.run` hook
 * matched on the literal name runs the type checker out of memory over every
 * connected MCP tool. The tool only writes this session's state.
 */
const serveProgress = async (
  $: Engine,
  input: unknown,
  agentId: string | undefined,
): Promise<{ deny: string } | { result: string }> => {
  const parsed = parseProgress(input);

  if (parsed === undefined) {
    return { deny: PROGRESS_ERROR };
  }

  const { goal, tasks } = parsed;

  if (agentId === undefined) {
    progressEpoch += 1;
    callsSinceProgress = 0;
    isListDoneThisTurn ||= isAllDone(tasks);
  }

  // The list was valid, so the call is answered as saved even if drawing it
  // fails: the model must not retry over the mod's own trouble.
  await safely(async () => {
    if (agentId !== undefined) {
      await changeCard($, agentId, (card) => ({ ...card, tasks }));
    } else {
      await update($, tasksAtom, () => tasks);
      await update($, goalAtom, () => (tasks.length === 0 ? null : goal));
    }
  });

  return { result: `Saved: ${countDone(tasks)} of ${tasks.length} done.` };
};

const changeCard = async (
  $: Engine,
  agentId: string,
  change: (card: AgentCard) => AgentCard,
): Promise<readonly AgentCard[]> => {
  // An id with no card (an engine fork, a card already dropped) writes
  // nothing, so nothing redraws for it.
  const cards = await read($, agentsAtom);

  if (!cards.some((card) => card.id === agentId)) {
    return cards;
  }

  return update($, agentsAtom, (list) =>
    list.map((card) => (card.id === agentId ? change(card) : card)),
  );
};

export const register: Register = (on) => {
  stopTicker();
  hasAutoOpened = false;
  isToolRegistered = false;
  resetCounters();

  // Fires at the session's start and again at every fresh load of the mod (a
  // reload, a worker respawn), so it registers but never resets: the state
  // outlives a reload. A new session starts with empty state anyway.
  on("session.start", async ($, e, next) => {
    await safely(async () => {
      await $.command.register({
        name: "crew",
        description: "Open the Crew pane with a card per subagent",
      });
    });
    await safely(async () => {
      const names = (await $.tool.list()).map((tool) => tool.name);

      if (!names.includes("TodoWrite") && !names.includes("TaskCreate")) {
        const registered = await $.tool.register({
          name: PROGRESS_NAME,
          description: PROGRESS_DESCRIPTION,
          inputSchema: PROGRESS_SCHEMA,
        });
        // Only the name the progress hook's matcher serves counts: under any
        // other the tool would go unanswered, so no reminder may point to it.
        isToolRegistered = registered?.tool === PROGRESS_TOOL;
      }
    });

    return next(e);
  });

  // `/clear` and a resume change the conversation in this process.
  on("session.end", async ($, e, next) => {
    if (e.reason === "clear" || e.reason === "resume") {
      await safely(() => resetAll($));
    }

    return next(e);
  });

  on("command.run", { command: "crew" }, async ($) => {
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE });
    isPaneOpen = true;
    await safely(async () => syncTicker($, await read($, agentsAtom)));

    // For the person alone: the mod never instructs the model.
    return { text: "Crew pane opened.", isTextDisplayOnly: true };
  });

  on("ui.close", async ($, e, next) => {
    if (e.id === PANE_ID) {
      await safely(async () => {
        isPaneOpen = false;
        syncTicker($, await read($, agentsAtom));

        // Only the person's own close stops auto-open; a plugin's does not.
        if (e.origin.kind === "person") {
          await update($, paneClosedAtom, () => true);
        }
      });
    }

    return next(e);
  }).catch(($, e, next) => next(e));

  on("prompt.submit", async ($, e, next) => {
    // Every prompt starts a turn, so the reminder counters start over.
    resetCounters();

    // Finished cards and a finished list stay until the person's own next
    // prompt: a background agent's completion also enters as a prompt.
    if (isPersonPrompt(e)) {
      await safely(async () => {
        const cards = await update($, agentsAtom, (list) =>
          list.filter((card) => card.status === "running"),
        );
        syncTicker($, cards);
        // A finished list has been seen: clear it. An unfinished one stays.
        const tasks = await update($, tasksAtom, (list) =>
          isAllDone(list) ? [] : list,
        );

        if (tasks.length === 0) {
          await update($, goalAtom, () => null);
        }
      });
    }

    return next(e);
  }).catch(($, e, next) => next(e));

  on("turn.start", async ($, e, next) => {
    const agentId = e.agentId;

    if (agentId !== undefined) {
      await safely(async () => {
        const known = await read($, agentsAtom);

        if (known.some((card) => card.id === agentId)) {
          return;
        }

        // Ids no list names (the engine's own forks) get no card.
        const info = (await $.agent.list()).find(
          (agent) => agent.id === agentId,
        );

        if (info === undefined) {
          return;
        }

        const card: AgentCard = {
          id: agentId,
          type: info.type,
          description: info.description,
          status: "running",
          startedAt: await $.clock.now(),
          toolCalls: 0,
          tasks: [],
        };
        const cards = await update($, agentsAtom, (list) =>
          list.some((one) => one.id === agentId) ? list : [...list, card],
        );

        if (!hasAutoOpened && !(await read($, paneClosedAtom))) {
          hasAutoOpened = true;
          isPaneOpen = true;
          void $.ui
            .open({ id: PANE_ID, title: PANE_TITLE })
            .catch(() => undefined);
        }

        syncTicker($, cards);
      });
    }

    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const agentId = e.agentId;

    if (agentId !== undefined) {
      await safely(async () => {
        const endedAt = await $.clock.now();
        const status =
          e.reason === "error" || e.reason === "aborted" ? "failed" : "done";
        const cards = await changeCard($, agentId, (card) => ({
          ...card,
          status,
          endedAt,
        }));
        syncTicker($, cards);
      });
    }

    return next(e);
  });

  // Only these hooks wrap a tool call, each matched to the tools it reads: a
  // `tool.call` hook that may match a tool turns off, for that tool, the move
  // to the background, a served call's live output and Code Mode's wait.

  // The own progress tool. The engine names a plugin's tool
  // mcp__<plugin>__<name>, so the pattern takes this plugin's and no other;
  // it is answered only while this load registered it, under that name.
  on(
    "tool.call",
    { tool: /^mcp__task-bar__progress$/ },
    async ($, e, next) => {
      const agentId = e.agentId;
      const tool = String(e.tool);

      if (!isToolRegistered) {
        return next(e);
      }

      // Answered here, so it is counted here: no PostToolUse is relied on.
      if (agentId !== undefined) {
        await safely(async () => {
          await changeCard($, agentId, (card) => ({
            ...card,
            toolCalls: card.toolCalls + 1,
            lastTool: tool,
          }));
        });
      }

      return serveProgress($, e, agentId);
    },
  ).catch(($, e, next) => next(e));

  on("tool.call", { tool: ["TodoWrite", "TaskCreate", "TaskUpdate"] }, async ($, e, next) => {
    const agentId = e.agentId;
    const ran = await next(e);

    if (ran.deny !== undefined || ran.isError === true) {
      return ran;
    }

    await safely(async () => {
      const result: unknown = ran.result;

      if (e.tool === "TodoWrite") {
        const fromResult = isRecord(result)
          ? parseTodos(result.newTodos)
          : undefined;
        const fromInput = parseTodos(e.todos);
        // Claude Code may answer an empty list once every item is done; the
        // input then still holds the finished list, which the done state shows.
        const todos =
          fromResult === undefined ||
          (fromResult.length === 0 &&
            fromInput !== undefined &&
            isAllDone(fromInput))
            ? fromInput
            : fromResult;

        if (todos === undefined) {
          return;
        }

        if (agentId !== undefined) {
          await changeCard($, agentId, (card) => ({ ...card, tasks: todos }));
        } else {
          await update($, tasksAtom, () => todos);
        }

        return;
      }

      // Subagents write the chat's shared list too, so these go to `tasks`.
      if (e.tool === "TaskCreate") {
        const created =
          isRecord(result) && isRecord(result.task) ? result.task : undefined;

        if (created === undefined || typeof created.id !== "string") {
          return;
        }

        const id = created.id;
        const title =
          typeof created.subject === "string" ? created.subject : e.subject;
        const task: Task = {
          id,
          title,
          ...(typeof e.activeForm === "string" && e.activeForm !== ""
            ? { activeTitle: e.activeForm }
            : {}),
          status: "pending",
        };
        await update($, tasksAtom, (tasks) =>
          tasks.some((one) => one.id === id) ? tasks : [...tasks, task],
        );

        return;
      }

      if (e.tool === "TaskUpdate") {
        if (!isRecord(result) || result.success !== true) {
          return;
        }

        const id = e.taskId;
        const status = e.status;

        if (status === "deleted") {
          await update($, tasksAtom, (tasks) =>
            tasks.filter((one) => one.id !== id),
          );

          return;
        }

        await update($, tasksAtom, (tasks) =>
          tasks.map((one) =>
            one.id === id
              ? {
                  ...one,
                  ...(typeof e.subject === "string"
                    ? { title: e.subject }
                    : {}),
                  ...(typeof e.activeForm === "string" && e.activeForm !== ""
                    ? { activeTitle: e.activeForm }
                    : {}),
                  ...(isTaskStatus(status) ? { status } : {}),
                }
              : one,
          ),
        );
      }
    });

    return ran;
  }).catch(($, e, next) => next(e));

  // A subagent's tool calls, counted from the result rows its conversation
  // keeps: that row's `agentId` is the id `turn.start` and `$.agent.list()`
  // use, and its origin names the tool. Only the name is read, never the row's
  // content. The progress call is counted where it is answered.
  on("session.append", { door: ["tool-result", "response"] }, async ($, e, next) => {
    const agentId = e.agentId;
    const origin = e.origin;

    // The main loop's response: note which tool calls it asks for, by id
    // alone (never their input), before the row is stored, so a PostToolUse
    // that lands meanwhile is already known to be its own.
    if (e.door === "response") {
      if (agentId === undefined) {
        for (const block of e.message.content) {
          const id: unknown = (block as { id?: unknown }).id;

          if (block.type === "tool_use" && typeof id === "string") {
            mainLoopToolUses.add(id);
          }
        }
      }

      return next(e);
    }

    const stored = await next(e);

    if (
      agentId !== undefined &&
      origin.kind === "tool" &&
      origin.tool !== "unknown" &&
      origin.tool !== PROGRESS_TOOL
    ) {
      const tool = origin.tool;
      await safely(async () => {
        await changeCard($, agentId, (card) => ({
          ...card,
          toolCalls: card.toolCalls + 1,
          lastTool: tool,
        }));
      });
    }

    return stored;
  }).catch(($, e, next) => next(e));

  // Main-loop calls are observed after they ran, without wrapping them: these
  // classic events read only `agent_id`, `tool_name` and `tool_use_id`. A
  // denied call raises neither, so it neither counts nor uses up a reminder.
  on("classic.PostToolUse", async ($, e, next) => {
    const answer = await next(e);
    const reminder = await afterToolCall(
      $,
      e.tool_name,
      e.agent_id,
      e.tool_use_id,
    );

    return reminder === undefined
      ? answer
      : { ...answer, additionalContext: [...(answer.additionalContext ?? []), reminder] };
  }).catch(($, e, next) => next(e));

  on("classic.PostToolUseFailure", async ($, e, next) => {
    const answer = await next(e);
    const reminder = await afterToolCall(
      $,
      e.tool_name,
      e.agent_id,
      e.tool_use_id,
    );

    return reminder === undefined
      ? answer
      : { ...answer, additionalContext: [...(answer.additionalContext ?? []), reminder] };
  }).catch(($, e, next) => next(e));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e);
    }

    const tasks = await read($, tasksAtom);

    if (tasks.length === 0) {
      return next(e);
    }

    const { Box, Text } = $.ui.resolve(e);
    const total = tasks.length;
    // The row is as wide as the band's body; the bar takes what the count and
    // the text leave, so it runs the full width.
    const columns = e.props.bodyColumns;

    if (isAllDone(tasks)) {
      const tail = `▏ All ${total} done`;
      const cells = Math.max(MIN_BAR_CELLS, columns - 1 - tail.length);

      return (
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text>▕</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={SUCCESS}>{"█".repeat(cells)}</Text>
          </Box>
          {/* Only the tail may give way, cut at its end. */}
          <Box flexShrink={1}>
            <Text wrap="truncate-end">{tail}</Text>
          </Box>
        </Box>
      );
    }

    const done = countDone(tasks);
    const count = `▏ ${done}/${total}`;
    // When room runs out the text is clipped first: the bar keeps its minimum.
    const room = columns - 1 - MIN_BAR_CELLS - count.length - 2;
    const current = currentText(tasks);
    const goal = await read($, goalAtom);
    const withGoal =
      goal === null ? current : current === "" ? goal : `${goal} · ${current}`;
    // The goal shows only when it fits whole beside the current item.
    const text = withGoal.length <= room ? withGoal : clip(current, room);
    const tail = text === "" ? count : `${count}  ${text}`;
    const cells = Math.max(MIN_BAR_CELLS, columns - 1 - tail.length);
    const filled = filledCells(done, total, cells);

    return (
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text>▕</Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={ACCENT}>{"█".repeat(filled)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{"░".repeat(cells - filled)}</Text>
        </Box>
        {/* Only the tail may give way, cut at its end: a safety net for wide
            characters and very narrow bands; the widths above still hold. */}
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{tail}</Text>
        </Box>
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const agents = await read($, agentsAtom);

    // A pane that draws is open: after a reload, which stops the ticker, this
    // starts it again. Drawing never fails over the ticker.
    isPaneOpen = true;
    try {
      syncTicker($, agents);
    } catch {
      // The next card event starts it instead.
    }

    if (agents.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No subagents in this chat yet.</Text>
        </Box>
      );
    }

    const now = await $.clock.now();
    const newestFirst = [...agents]
      .reverse()
      .sort((a, b) => b.startedAt - a.startedAt);

    // Cards sit border to border, newest first.
    return (
      <Box flexDirection="column">
        {newestFirst.map((card) => {
          const dot =
            card.status === "running"
              ? ACCENT
              : card.status === "done"
                ? SUCCESS
                : DANGER;
          // A tint of the status behind the whole card: the theme's dimmed
          // diff fills, made to keep text readable in light and dark. Desktop
          // only: the terminal left patches behind the text rows in the live
          // look. The theme has no such fill for its accent, so a running card
          // has none.
          const tint =
            e.surface !== "desktop"
              ? undefined
              : card.status === "done"
                ? "diffAddedDimmed"
                : card.status === "failed"
                  ? "diffRemovedDimmed"
                  : undefined;
          const elapsed = formatElapsed((card.endedAt ?? now) - card.startedAt);
          const calls = `${card.toolCalls} tool ${card.toolCalls === 1 ? "call" : "calls"}`;
          const last =
            card.lastTool === undefined ? "" : ` · last: ${card.lastTool}`;
          const done = countDone(card.tasks);
          const filled = filledCells(done, card.tasks.length, CARD_BAR_CELLS);

          return (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={dot}
              paddingX={1}
              {...(tint === undefined ? {} : { backgroundColor: tint })}
            >
              <Box flexDirection="row">
                <Box flexShrink={0}>
                  <Text color={dot}>● </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text weight="bold" wrap="truncate-end">
                    {card.type}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text color={dot}>
                    {" "}
                    {card.status} {elapsed}
                  </Text>
                </Box>
              </Box>
              <Text wrap="truncate-end">
                {"  "}
                {card.description}
              </Text>
              <Text dimColor wrap="truncate-end">
                {"  "}
                {calls}
                {last}
              </Text>
              {card.tasks.length > 0 && (
                <Box flexDirection="row">
                  <Box flexShrink={0}>
                    <Text>{"  "}▕</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text color={ACCENT}>{"█".repeat(filled)}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text dimColor>{"░".repeat(CARD_BAR_CELLS - filled)}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text>
                      ▏ {done}/{card.tasks.length}
                    </Text>
                  </Box>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    );
  });
};
