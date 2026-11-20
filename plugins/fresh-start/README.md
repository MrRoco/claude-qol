# fresh-start

Moves a long chat into a new one without losing the thread.

- **Offer above the prompt.** Once the chat's context passes a token threshold (250,000 by
  default), a row above the prompt says how big the chat is (`◆ This chat is at 252k tokens.`)
  with **Write handoff** and **Not now**. Not now hides the offer for the rest of this
  conversation.
- **Handoff written in the chat.** Write handoff asks Claude, in the current chat, for a
  handoff in fixed sections: goal, done so far, current state, decisions and rules, key files
  and commands, problems solved and next steps. While Claude writes, the row shows the steps
  (writing, saving, choose) with a moving bar and the elapsed time, and **Cancel** to stop
  waiting for it (Claude's reply then stays in the chat but is not saved).
- **Saved first.** As soon as the answer is in, it is saved as Markdown in your project, before
  anything else happens, so nothing is lost if the next step fails.
- **Then you choose.** **Start fresh chat** clears the conversation and puts the handoff in the
  prompt box of the new chat, for you to read, edit and send yourself. **Copy** puts it on the
  clipboard. **Cancel** keeps the file and closes the row.

On a wide terminal (100 columns or more) the row keeps to half the width, so task-bar can put
it beside another row; its texts are shorter there (`◆ Chat at 252k tokens.`, only the file
name after saving), and the buttons always stay whole.

The mod never starts a fresh chat or sends the handoff on its own: both happen only on your
press. Apart from its own handoff request, it only observes the chat.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install fresh-start@qol
```

## Use

- `/fresh` starts the same flow at any time, also after Not now.
- **Threshold:** the `Offer threshold (tokens)` row in Claude Code's config menu, or the
  `threshold` option under `pluginConfigs` for `fresh-start` in your settings. The minimum is
  20,000 tokens: a lower value (or one that is not a number) falls back to the default of
  250,000.

## Limits

The mod takes Claude's reply to the first new turn of the chat after it asks, skipping turns
it can tell belong to something else (a subagent, a prompt you or a task notification sent, a
turn with no text). It can still pick the wrong turn, or keep waiting, in a few cases; use
**Cancel** and `/fresh` again if the row seems stuck or saved the wrong reply:

- A slash or skill command sent while a handoff is being written counts as one turn to skip.
  A command that starts no turn (such as `/help`) then makes the mod skip the handoff turn
  itself, and it keeps waiting.
- A prompt that another mod rewrites before its turn starts is not recognised as someone
  else's.

## Where files go

Each handoff is saved as `<project>/.claude/handoffs/<yyyy-mm-dd>-<HHmm>.md` (local time; a
second one in the same minute gets `-2`, `-3`). The first line notes when it was written and
the context size. The mod also writes `.claude/handoffs/.gitignore` containing `*`, so the
folder keeps itself out of git without touching your project's own `.gitignore`. Nothing is
written anywhere else.

The `-2`, `-3` count lives only in the running mod, so two handoffs in the same minute after a
reload of the mod, or from a second Claude Code process in the same project, can overwrite each
other.

A short run log (time, token count, file name and your choice, at most the last 20 runs) is
kept in the mod's own store under your Claude Code configuration. It never holds the handoff
text or the chat's topic.

## Privacy

A handoff sums up the whole chat, so it can contain client names, URLs, ticket numbers, code
and data. Claude is asked to leave out secrets and to name outside people by role, but that is
best effort: **read a handoff before you share it** with anyone or paste it somewhere else.
The files stay on your machine in the project folder, and cleaning up `.claude/handoffs/` is up
to you; deleting a file removes the handoff. Copy puts the text on your system clipboard, only
when you press it. Nothing is sent to the network.

## License

MIT
