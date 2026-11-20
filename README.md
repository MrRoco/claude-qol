# claude-qol

Quality-of-life mods for [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview.md).
Each mod is a small plugin that adds a helper or changes what you see while you work.

## Mods

| Mod              | What it does                                                           | Status  |
| ---------------- | ---------------------------------------------------------------------- | ------- |
| `task-bar`       | Progress of Claude's to-do list and subagents                          | planned |
| `fresh-start`    | Hand a long chat over to a fresh one                                   | planned |
| `cache-timer`    | Time left before the prompt cache goes cold                            | planned |
| `prompt-shaper`  | Turn a loose prompt into a clear brief                                 | planned |
| `lesson-saver`   | Save a correction as a lasting rule                                    | planned |
| `chat-ledger`    | What this chat used: tools, files, skills                              | planned |
| `privacy-mask`   | Hide personal details on screen while recording                        | planned |
| `replay-theater` | Step through the last turn's file edits (Anthropic sample, Apache 2.0) | planned |
| `mod-switch`     | Turn mods on and off from one panel                                    | planned |

## Requirements

Claude Code 2.1.328 or later (tested version). Check with `claude --version`.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install <mod>@qol
```

## Develop

```bash
claude --plugin-dir ./plugins/<mod>   # load one mod with hot reload
scripts/check.sh                      # validate and test everything
```

## License

MIT, see `LICENSE`. `replay-theater` keeps its own Apache 2.0 license.
