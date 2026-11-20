# replay-theater

Step through the file edits Claude made in the last turn, one diff at a time.

This is a modified copy of the `replay-theater` sample mod from Anthropic's
[claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater)
repository, restyled for the qol marketplace. It is not an official Anthropic product and is
not endorsed by Anthropic. It is licensed under the Apache License 2.0 (see `LICENSE`); the
changes are listed in `NOTICE`.

- **Hint above the prompt.** After a turn in which Claude edited files, a row above the prompt
  says how many edits there were (`▶ 3 file edits in the last turn`) with a **Replay** button
  (hotkey `r`).
- **One edit at a time.** `/replay` or the button opens a side pane with one edit per step: the
  file, a line diff with added and removed lines in your theme's success and error colours,
  the `+N` / `-N` counts, and **◀ Previous**, **Next ▶** and **Close**.
- **Main turn only.** Edits by subagents are left out.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install replay-theater@qol
```

## Use

- `/replay` opens the pane for the last turn that edited files.
- In the pane: `n` next edit, `p` previous edit, `c` or `Escape` closes it. Mouse clicks on the
  buttons work too.
- To reach the hint's button from the keyboard, focus the row above the prompt and press `r`.
- A turn without edits keeps the previous replay; the next turn with edits replaces it.

## What each step shows

- **Edit:** the diff between the old and the new text of that edit, not the whole file. A
  replace-all edit is noted as `all occurrences`.
- **MultiEdit:** one step per change, noted as `change 2 of 3`.
- **Write:** the diff between the file on disk just before the write and the new content, noted
  as `whole file`, or `new file` when the file did not exist yet.
- Up to 12 diff lines per step, then `… 12 more lines`. Unchanged lines show only next to a
  change; a skipped run shows as `⋯`. Files over 400 lines show as all removed, then all added.

## Limits

- Edits are recorded when the tool is called, so an edit you deny, or that fails, still shows.
- The replay lives in memory only and is gone after a restart or a reload of the mod.
- When the terminal has no room for a side pane, the replay draws in the row above the prompt
  instead.
- MultiEdit is handled for builds that have that tool; Claude Code 2.1.328 does not list it.

## Privacy

To diff a Write, the mod reads the file that is about to be replaced. File contents stay in
memory for the replay and show on screen only when you open it. Nothing is written, logged or
sent anywhere.

## License

Apache License 2.0, see `LICENSE` and `NOTICE`. Based on replay-theater from
anthropics/claude-code-playground, Copyright 2026 Anthropic PBC.
