# chat-ledger

A **Ledger** pane that keeps a running tally of what the current chat has touched, so you can
see at a glance which connectors, files, skills and instruction files played a part.

- **Connectors.** Every MCP server Claude called, with the number of calls and, when some went
  wrong, how many failed. Press a server's row to fold out the calls per tool.
- **Files.** Every file Claude read, edited or created, with how often. Paths inside the
  project are shown relative to it, paths elsewhere in your home folder start with `~`. In
  the terminal each path is a link that opens the file.
- **Skills and commands.** The skills that were loaded and the slash commands that were run,
  each with a count.
- **Context files.** The instruction files loaded into the context (`CLAUDE.md` files, memory,
  rules), each with its kind (`project`, `user`, `local`, `managed`, `memory`).

Calls made by subagents count too. Each section heading shows its count; a section with
nothing in it yet says `none yet`. Rows are sorted with the most used first, then by name;
context files keep the order in which they were loaded.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install chat-ledger@qol
```

## Use

- `/ledger` opens the pane. It keeps updating while the chat runs.
- **Copy as Markdown** at the bottom of the pane puts the whole ledger on the clipboard, as a
  `# Chat ledger` document with one `##` section per list.
- `/clear` (or resuming another conversation) starts a new, empty ledger. Reloading the mod
  keeps the current one.

## Privacy

The ledger only keeps names and counts: tool and server names, file paths, skill and command
names, and the path and kind of each instruction file. It never keeps what a tool was asked or
answered, the arguments of a command, or the text of an instruction file. Nothing is written
to disk, logged or sent anywhere; the list lives in the session's memory and is gone when the
session ends. It only reaches your clipboard when you press **Copy as Markdown**.

## Limits

- **Context files need approval.** The context files list is filled from Claude Code's
  `prompt.context` event, and skill loads by `/name` come from its `skill.prompt` event. A
  security plugin such as `cc-plugin-sec-default` may skip these hooks until the mod is
  approved for it. Until then the context files list stays empty and skills run by `/name`
  are not counted (skills Claude loads itself still are).
- **Created or edited.** A write to a file the ledger has not seen yet counts as `created`;
  the mod does not look at the disk, so overwriting an existing file you had not read first
  also shows as created.
- **Failed file calls are left out.** A read or edit that failed or was denied is not counted;
  a failed connector call is counted, as failed.
- **Reloads.** A call that is still running while the mod reloads is counted from its result
  alone: connectors still are, files are not.
- **Links.** File links open only where the terminal supports them; the desktop app shows the
  paths as plain text.
- Connector names come from the server name Claude Code reports. For a server it has not
  described yet, the name is taken from the tool name (`mcp__<server>__<tool>`).
