# cache-timer

Shows, above the prompt, how long this chat's prompt cache stays warm while you are idle.

Claude Code caches the start of each request so the next message is cheaper and faster. That
cache only lives for a while: five minutes or one hour, depending on what the last request got.
Once it expires, the next message pays full price to read the whole chat again. cache-timer
makes that clock visible.

## What it shows

After each answer a row appears above the prompt:

```text
◷ Cache warm  ▕██████████░░░░▏ 41:07 left · 1 h   [Keep warm]
```

- The bar and the time count down to the moment the cache expires. The lifetime (`5 min` or
  `1 h`) is the one the chat's last request got.
- In the last minute the row turns to the theme's warning colour.
- The row hides while Claude is working and while a survey is open.
- When the time is up, the row turns dim and says how many tokens the next message re-reads at
  full price. **Hide** puts it away until the next request.
- On a wide window (100 columns or more) the row takes at most half the width, so other rows
  have room beside it.

Subagents keep their own caches; the row only follows the main chat.

## Keep warm

**Keep warm** sends one tiny side request that re-reads the chat's cache, which restarts the
countdown. Nothing is added to the chat. It only runs when you press it, never by itself.

Cost: each press costs about the size of the chat at the cache-read rate, plus a few tokens for
the ping itself. For a chat of 40k tokens that is a cent or two. The row shows what the last
press cost (`· kept warm $0.02`), when Claude Code reports a cost.

The button does nothing in the first 10 seconds after an answer, and while a press is still
running.

## Start fresh

When the cache has gone cold on a big chat, the cold row also offers **Start fresh**, which runs
the [fresh-start](../fresh-start/README.md) mod's command to write a handoff and continue in a
new chat. The button only shows when fresh-start is installed and the chat is at or above
fresh-start's threshold (250,000 tokens unless you changed it in `/config`).

## Limits

- The lifetime is only known after the first answer of a chat; before that there is no row.
- The countdown is worked out from when the last request started. It is a close estimate, not
  a reading of the cache itself.
- It is not known whether compaction updates the countdown; compaction builds a new cache
  anyway.
- After a reload the ticker restarts from the last known time; a Keep warm press that was
  running during the reload is forgotten.
- A press right after `/clear` or before the first answer has nothing to keep warm and only
  shows a toast.
- Built for Claude Code 2.1.328; unit tests cover the terminal and desktop surfaces.

## Privacy

The mod keeps only times, token counts and the last press's cost, in memory for the
conversation. It writes nothing to disk, logs or the network. Keep warm resends the chat's own
request to Anthropic, the same data and destination as the chat itself, plus a fixed ping text.
