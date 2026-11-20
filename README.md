# claude-qol

Quality-of-life mods for [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview.md).
Each mod is a small plugin that adds a helper or changes what you see while you work.

## Mods

| Mod              | What it does                                                           | Status  |
| ---------------- | ---------------------------------------------------------------------- | ------- |
| `task-bar`       | Progress of Claude's to-do list and subagents                          | 0.1.0   |
| `fresh-start`    | Hand a long chat over to a fresh one                                   | 0.1.0   |
| `cache-timer`    | Time left before the prompt cache goes cold                            | 0.1.0   |
| `prompt-shaper`  | Turn a loose prompt into a clear brief                                 | 0.1.0   |
| `lesson-saver`   | Save a correction as a lasting rule                                    | 0.1.0   |
| `chat-ledger`    | What this chat used: tools, files, skills                              | 0.1.0   |
| `privacy-mask`   | Hide personal details on screen while recording                        | 0.1.0   |
| `replay-theater` | Step through the last turn's file edits (Anthropic sample, Apache 2.0) | 0.1.0   |
| `mod-switch`     | Turn mods on and off from one panel                                    | 0.1.0   |

## Requirements

Claude Code 2.1.328 or later (tested version). Check with `claude --version`.

## Install

### 1. Add the marketplace (once)

From your terminal:

```bash
claude plugin marketplace add MrRoco/claude-qol
```

Or inside Claude Code, at the prompt:

```text
/plugin marketplace add MrRoco/claude-qol
```

`MrRoco/claude-qol` is short for the GitHub repository; the full URL
`https://github.com/MrRoco/claude-qol` works too.

### 2. Install the mods

One mod, from your terminal:

```bash
claude plugin install task-bar@qol
```

All nine at once:

```bash
for m in task-bar fresh-start cache-timer prompt-shaper lesson-saver chat-ledger privacy-mask replay-theater mod-switch; do
  claude plugin install "$m@qol"
done
```

Inside Claude Code, use `/plugin install task-bar@qol`, or pick mods from the list that
`/plugin` opens.

### 3. Load them

Start a new chat, or run `/reload-plugins` in a chat that was already open. Settings for mods
that have them (fresh-start, prompt-shaper, lesson-saver, privacy-mask) are in `/config`.

### Check

```bash
claude plugin marketplace list
claude plugin list
```

`qol` shows in the marketplace list, and the installed mods end in `@qol`.

## Update

```bash
claude plugin marketplace update qol
claude plugin update <mod>@qol
```

## Organizations

Some mods use classic hooks or read and write files (see each mod's README for what and why).
Under a security policy such as `cc-plugin-sec-default`, an admin may need to approve a mod
before all of its hooks run.

## Develop

```bash
claude --plugin-dir ./plugins/<mod>   # load one mod with hot reload
scripts/check.sh                      # validate and test everything
```

## License

MIT, see `LICENSE`. `replay-theater` keeps its own Apache 2.0 license.
