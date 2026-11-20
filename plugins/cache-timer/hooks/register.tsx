import { atom, read, update } from "claude-code";
import type {
  CommandInfo,
  EngineInterface,
  Register,
  Timer,
  TurnUsage,
} from "claude-code";

import type { CacheTtl } from "../types";

type Engine = EngineInterface;

const TICK_MS = 1000;
const FIVE_MINUTES_MS = 300_000;
const ONE_HOUR_MS = 3_600_000;
// The countdown turns to the warning colour in its last minute.
const WARNING_MS = 60_000;
// A fork fired right after a turn once wrote the cache instead of reading
// it (spike), so Keep warm waits this long after the main turn ends.
const SETTLE_MS = 10_000;

const DEFAULT_THRESHOLD = 250_000;
// fresh-start's userConfig field, as `$.config.list()` keys it.
const THRESHOLD_KEY = "fresh-start.threshold";
const FRESH_PLUGIN = "fresh-start";
const FRESH_COMMAND = "fresh";

const MIN_BAR_CELLS = 10;
const MAX_BAR_CELLS = 30;
// From this body width on the row shares the band: it takes at most half.
const HALF_WIDTH_FROM = 100;

// Theme keys only, never fixed colours.
const ACCENT = "claude";
const WARNING = "warning";

// The only text the mod ever sends the model, and only on a press.
const PING_PROMPT = "cache-timer keep-warm ping. Reply with only: ok";

const TEXT_NOTHING = "Nothing to keep warm yet.";
const TEXT_NO_REPLY = "Keep warm got no reply.";
const TEXT_FRESH_FAILED = "Could not start fresh-start.";

const lastRequestAtAtom = atom(
  { plugin: "cache-timer", key: "lastRequestAt" } as const,
  null,
);
const ttlAtom = atom({ plugin: "cache-timer", key: "ttl" } as const, null);
const tokensAtom = atom(
  { plugin: "cache-timer", key: "tokens" } as const,
  null,
);
const warmingAtom = atom(
  { plugin: "cache-timer", key: "warming" } as const,
  false,
);
const lastPingAtom = atom(
  { plugin: "cache-timer", key: "lastPing" } as const,
  null,
);
const hiddenAtom = atom(
  { plugin: "cache-timer", key: "hiddenUntilTurn" } as const,
  false,
);

// Module variables: they live until a reload, `/clear` does not touch them.
let ticker: Timer | undefined;
// Set once the row (or its Hide) has been drawn cold: the ticker then stops.
let isColdDrawn = false;
// ms of the last main `turn.complete`; null after a reload or `/clear`.
let lastTurnCompleteAt: number | null = null;
// A Keep warm request of this module instance is in flight.
let isPingInFlight = false;
// Bumped at every session end (`/clear` among them): a ping that answers
// after it belongs to the old conversation and writes nothing.
let conversationEpoch = 0;

const stopTicker = (): void => {
  ticker?.cancel();
  ticker = undefined;
};

/** Redraws the row once a second until it has been drawn cold once. */
const startTicker = ($: Engine): void => {
  isColdDrawn = false;

  if (ticker !== undefined) {
    return;
  }

  ticker = $.clock.every(TICK_MS, () => {
    if (isColdDrawn) {
      stopTicker();

      return;
    }

    void $.ui.invalidate("ui.render");
  });
};

/** Runs own work so that a failure never reaches the event or the turn. */
const safely = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch {
    // Observe only: the event goes on untouched.
  }
};

/** The lifetime a response's cache write got; null when it wrote nothing. */
const ttlOf = (usage: TurnUsage): CacheTtl | null => {
  if ((usage.ephemeral_1h_input_tokens ?? 0) > 0) {
    return "1h";
  }

  if ((usage.ephemeral_5m_input_tokens ?? 0) > 0) {
    return "5m";
  }

  return null;
};

const lifetimeMs = (ttl: CacheTtl): number =>
  ttl === "1h" ? ONE_HOUR_MS : FIVE_MINUTES_MS;

const pad = (value: number): string => String(value).padStart(2, "0");

/** `m:ss` under an hour, `h:mm:ss` from an hour on. */
const formatLeft = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
};

const formatTokens = (tokens: number): string =>
  `${Math.round(tokens / 1000)}k`;

// `≈`: the session's cost before and after the ping, so other spend in the
// same seconds (a subagent, another mod) can be counted in.
const formatCost = (usd: number): string =>
  usd < 0.01 ? "≈<$0.01" : `≈$${usd.toFixed(2)}`;

const readCost = async ($: Engine): Promise<number | null> => {
  try {
    const usd = (await $.session.usage()).cost?.usd;

    return typeof usd === "number" && Number.isFinite(usd) ? usd : null;
  } catch {
    return null;
  }
};

/** fresh-start's threshold from `/config`, or the default when unreadable. */
const readThreshold = async ($: Engine): Promise<number> => {
  try {
    const row = (await $.config.list()).find(
      (entry) => entry.key === THRESHOLD_KEY,
    );
    const value = row?.value;

    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
};

/** fresh-start's own command as listed, or undefined when not installed. */
const findFreshCommand = async ($: Engine): Promise<string | undefined> => {
  try {
    const commands: CommandInfo[] = await $.command.list();
    const found = commands.find(
      (command) =>
        command.plugin === FRESH_PLUGIN &&
        (command.name === FRESH_COMMAND ||
          command.name.endsWith(`:${FRESH_COMMAND}`)),
    );

    return found?.name;
  } catch {
    return undefined;
  }
};

/** At most half the body from 100 columns on, so the band has room beside it. */
const rowWidth = (bodyColumns: number): number =>
  bodyColumns >= HALF_WIDTH_FROM
    ? Math.floor((bodyColumns - 1) / 2)
    : bodyColumns;

const toastFailure = (
  $: Engine,
  reply: { reason: string; status?: number | null },
): void => {
  if (reply.reason === "nothing-to-fork") {
    $.ui.toast(TEXT_NOTHING);
  } else if (reply.reason === "api-error") {
    $.ui.toast(`Keep warm failed (${reply.status ?? "no response"}).`);
  } else {
    $.ui.toast(TEXT_NO_REPLY);
  }
};

/**
 * Re-reads the chat's cache with one side request, nothing added to the chat.
 * Taken in one synchronous update, so two presses send one request.
 */
const pressKeepWarm = async ($: Engine): Promise<void> => {
  let isClaimed = false;

  try {
    const now = await $.clock.now();
    await update($, warmingAtom, (warming) => {
      const isTooSoon =
        lastTurnCompleteAt !== null && now - lastTurnCompleteAt < SETTLE_MS;

      if (warming || isPingInFlight || isTooSoon) {
        return warming;
      }

      isClaimed = true;
      isPingInFlight = true;

      return true;
    });
  } catch {
    // Nothing was sent; the press is simply lost.
  }

  if (!isClaimed) {
    return;
  }

  const epoch = conversationEpoch;
  const isCurrent = (): boolean => epoch === conversationEpoch;

  try {
    const sentAt = await $.clock.now();
    const costBefore = await readCost($);
    // Never an `effort`: it can force a cache write instead of a read.
    const reply = await $.model.fork({ prompt: PING_PROMPT });
    const costAfter = await readCost($);
    // The fork's usage holds token counts only, no price: the session's
    // cost delta is the closest figure, shown as an estimate.
    const costUsd =
      costBefore !== null && costAfter !== null
        ? Math.max(0, costAfter - costBefore)
        : null;

    if (!isCurrent()) {
      return;
    }

    if (reply.isAnswered) {
      // The ping read the whole prefix, which restarts its lifetime.
      await update($, lastRequestAtAtom, (last) =>
        isCurrent() ? sentAt : last,
      );
      await update($, lastPingAtom, (last) =>
        isCurrent() ? { at: sentAt, costUsd, ok: true } : last,
      );

      if (isCurrent()) {
        startTicker($);
      }
    } else {
      await update($, lastPingAtom, (last) =>
        isCurrent()
          ? { at: sentAt, costUsd, ok: false, reason: reply.reason }
          : last,
      );
      toastFailure($, reply);
    }
  } catch {
    if (isCurrent()) {
      await safely(async () => {
        const at = await $.clock.now();
        await update($, lastPingAtom, (last) =>
          isCurrent()
            ? { at, costUsd: null, ok: false, reason: "error" }
            : last,
        );
      });
      $.ui.toast(TEXT_NO_REPLY);
    }
  } finally {
    isPingInFlight = false;
    // Also after a `/clear`: false is the new conversation's default too.
    await safely(async () => {
      await update($, warmingAtom, () => false);
    });
  }
};

const pressHide = async ($: Engine): Promise<void> => {
  // Nothing left to count down: the ticker may stop.
  isColdDrawn = true;
  await update($, hiddenAtom, () => true);
};

/** Runs fresh-start's command; never awaited by the press itself. */
const pressStartFresh = ($: Engine, command: string): void => {
  try {
    void $.command.run({ command }).catch(() => $.ui.toast(TEXT_FRESH_FAILED));
  } catch {
    $.ui.toast(TEXT_FRESH_FAILED);
  }
};

export const register: Register = (on) => {
  // A reload drops the old module's timers; this one starts without any.
  stopTicker();

  // Fires at the session's start and at every reload: never resets the
  // countdown, only restarts the ticker the reload stopped.
  on("session.start", async ($, e, next) => {
    await safely(async () => {
      if ((await read($, lastRequestAtAtom)) !== null) {
        startTicker($);
      }

      // A ping of a module that was reloaded away never ends: no row may
      // wait on it for ever.
      if (!isPingInFlight) {
        await update($, warmingAtom, (warming) =>
          isPingInFlight ? warming : false,
        );
      }
    });

    return next(e);
  });

  on("session.end", ($, e, next) => {
    stopTicker();
    lastTurnCompleteAt = null;
    conversationEpoch += 1;

    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    const tokens = e.context.tokens;

    if (typeof tokens === "number" && Number.isFinite(tokens)) {
      await safely(async () => {
        await update($, tokensAtom, () => tokens);
      });
    }

    return next(e);
  });

  // One model request of a turn. Only the main chat's: subagents cache their
  // own prefix and never touch the main one.
  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e);
    }

    // The cache lifetime counts from the request's start.
    let at: number | null = null;

    try {
      at = await $.clock.now();
    } catch {
      at = null;
    }

    const result = yield* next(e);

    await safely(async () => {
      await update($, hiddenAtom, () => false);
      // A newer answer: the last press's cost is old news.
      await update($, lastPingAtom, () => null);
      const usage = result.usage;

      // No response, no cache touched: keep the last good state.
      if (usage === null || at === null) {
        return;
      }

      const requestAt = at;
      const ttl = ttlOf(usage);
      await update($, lastRequestAtAtom, () => requestAt);

      if (ttl !== null) {
        await update($, ttlAtom, () => ttl);
      }
    });

    return result;
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) {
      await safely(async () => {
        startTicker($);
        lastTurnCompleteAt = await $.clock.now();
      });
    }

    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const lastRequestAt = await read($, lastRequestAtAtom);
    const ttl = await read($, ttlAtom);

    if (
      e.props.isWorking ||
      e.props.hasSurvey ||
      lastRequestAt === null ||
      ttl === null
    ) {
      return next(e);
    }

    const now = await $.clock.now();
    const total = lifetimeMs(ttl);
    const left = lastRequestAt + total - now;

    if (left <= 0) {
      isColdDrawn = true;
    }

    if (await read($, hiddenAtom)) {
      return next(e);
    }

    const { Box, Button, Text } = $.ui.resolve(e);
    const columns = rowWidth(e.props.bodyColumns);

    const fixed = (text: string, color?: string) => (
      <Box flexShrink={0}>
        {color === undefined ? (
          <Text dimColor>{text}</Text>
        ) : (
          <Text color={color}>{text}</Text>
        )}
      </Box>
    );
    const button = (key: string, label: string, onPress: () => void) => (
      <Box flexShrink={0} marginLeft={1}>
        <Button key={key} label={label} onPress={onPress} />
      </Box>
    );

    if (await read($, warmingAtom)) {
      return (
        <Box flexDirection="row" width={columns}>
          {fixed("◷ Keeping warm…", ACCENT)}
        </Box>
      );
    }

    if (left <= 0) {
      const tokens = await read($, tokensAtom);
      const amount =
        tokens === null ? "the whole chat" : `${formatTokens(tokens)} tokens`;
      const threshold = await readThreshold($);
      const freshCommand =
        tokens !== null && tokens >= threshold
          ? await findFreshCommand($)
          : undefined;

      return (
        <Box flexDirection="row" width={columns}>
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {`○ Cache cold · the next message re-reads ${amount} at full price`}
            </Text>
          </Box>
          {freshCommand !== undefined &&
            button("start-fresh", "Start fresh", () =>
              pressStartFresh($, freshCommand),
            )}
          {button("hide", "Hide", () => void pressHide($))}
        </Box>
      );
    }

    const color = left <= WARNING_MS ? WARNING : ACCENT;
    const label = "◷ Cache warm  ";
    const time = `▏ ${formatLeft(left)} left`;
    const ping = await read($, lastPingAtom);
    const pingText =
      ping !== null && ping.ok && ping.costUsd !== null
        ? ` · kept warm ${formatCost(ping.costUsd)}`
        : "";
    const suffix = ` · ${ttl === "1h" ? "1 h" : "5 min"}`;
    // The bar takes what the texts and the button leave, within bounds; once
    // it is at its minimum the label and the suffix clip, never the button.
    const buttonWidth = " Keep warm ".length + 3;
    const cells = Math.min(
      MAX_BAR_CELLS,
      Math.max(
        MIN_BAR_CELLS,
        columns -
          label.length -
          1 -
          time.length -
          suffix.length -
          pingText.length -
          buttonWidth,
      ),
    );
    const filled = Math.min(
      cells,
      Math.max(1, Math.round((cells * left) / total)),
    );

    return (
      <Box flexDirection="row" width={columns}>
        <Box flexShrink={1}>
          <Text color={color} wrap="truncate-end">
            {label}
          </Text>
        </Box>
        {fixed("▕", color)}
        <Box flexShrink={0}>
          <Text color={color}>{"█".repeat(filled)}</Text>
        </Box>
        {filled < cells && fixed("░".repeat(cells - filled))}
        {fixed(time, color)}
        <Box flexShrink={1}>
          <Text color={color} wrap="truncate-end">
            {suffix}
          </Text>
        </Box>
        {pingText !== "" && (
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {pingText}
            </Text>
          </Box>
        )}
        {button("keep-warm", "Keep warm", () => void pressKeepWarm($))}
      </Box>
    );
  });
};
