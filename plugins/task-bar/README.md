# task-bar

Shows how far Claude is with its to-do list, and what its subagents are doing.

- **Progress bar above the prompt.** While Claude works through a to-do list (TodoWrite, or
  TaskCreate/TaskUpdate), one row shows a bar that fills as items complete, the count (`3/5`)
  and what Claude is doing now. When the last item completes the row shows `All 5 done` until
  you send your next prompt.
- **Crew pane.** One card per subagent of this chat: its type, model and effort, its task,
  running/done/failed, elapsed time, tool calls and the last tool it used, and how full its
  context is. A subagent with its own to-do list gets a small bar on its card. Finished cards
  are cleared at your next prompt.
- **Card details.** Press a card's title to open it (one at a time; press again to close):
  model (and any fallback), context, tokens in and out with the cache share, estimated cost in
  dollars, calls per tool, its full to-do list, its worktree, when and by whom it was started,
  why it failed, and its full task. A card keeps these after the subagent has finished.
- **Tidy rows above the prompt.** The mod arranges the rows other mods put above the prompt:
  fresh-start and cache-timer on top (side by side from 100 columns, when both show), other
  mods' rows in their own order below them, and task-bar's bar last, right above the prompt.
  The rows themselves are never changed or hidden. At 100 columns or more, another mod's
  `AbovePromptList` hook that runs below task-bar gets the rows in groups (each top row
  alone, then the rest), not as one list.

Where Claude Code offers none of its own to-do tools, the mod gives Claude a `progress` tool
to send its list with, optionally with a goal shown in the bar (`3/5  Refactor auth · Running
tests`). Only then does it add one of two short reminders to a tool result: on the 4th tool
call of a turn without a list, and after 8 tool calls without a list update while items are
open, at most once per 8 calls. The reminders ride on Claude Code's PostToolUse hook events,
so they only reach Claude where those hook events run: a security or policy plugin may skip
them for mods it has not approved. Otherwise the mod only observes: it answers its own
`progress` tool, and never changes or blocks other tools' calls.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install task-bar@qol
```

## Use

- `/crew` opens the Crew pane.
- The pane also opens by itself the first time a subagent starts in a session, unless you
  closed it earlier in that session.

## Privacy

Task titles and subagent descriptions are kept in memory for the current session only. Nothing
is written to disk, logs or the network. Tool inputs and results are never stored or shown,
only the tool's name.

## License

MIT
