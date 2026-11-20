# lesson-saver

Turns the corrections you give Claude into rules it keeps, without you writing them down.

- **Watches short corrections.** After each short prompt you type, a small separate request
  (not part of the chat) reads the end of Claude's previous answer and your prompt, and decides
  whether you corrected Claude in a way that should hold beyond this task: a preference, a
  convention or a mistake to avoid. One-off instructions, questions and approvals are ignored.
- **Drafts one rule.** When it is such a correction, a row above the prompt shows the drafted
  rule (`✎ Lesson: …`) with **Save to project**, **Save globally**, **Edit** and **Skip**. The
  button for the file the check thinks fits best comes first.
- **You decide.** Nothing is written until you press Save. **Edit** opens the rule in a text
  field in the row; Enter keeps your version. **Skip** drops it.
- **No repeats.** A rule close to one already saved (in either file) is not offered again, and
  saving a near-duplicate tells you so instead of writing it.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install lesson-saver@qol
```

## Where rules go

- **Save to project** writes to `CLAUDE.md` at the project root (created when missing).
- **Save globally** writes to `~/.claude/CLAUDE.md`, which Claude reads in every project.

Each rule becomes one line under a `## Rules from corrections` heading, for example
`- Run the linter before every commit (added 20-11-2026)`. The line goes after the last rule
in that section; when the section is missing, it is added at the end of the file. The rest
of the file is left exactly as it was. The mod never touches any other file, and never edits
or removes saved rules: tidy them by hand when you like.

## Settings

In Claude Code's config menu, or under `pluginConfigs` for `lesson-saver` in your settings:

- **Check prompts up to (characters)** (`maxLength`, default 400): longer prompts are never
  checked. A value below 40, or one that is not a number, falls back to 400.
- **Model for the check** (`model`, `haiku` or `sonnet`, default `haiku`).

## Cost

One small request per typed prompt up to the length limit. With `haiku` that is roughly
$0.0001 per prompt; `sonnet` costs more. It counts towards the session's cost like any other
request. Slash commands, long prompts and prompts before Claude's first answer are not checked.

## Privacy

- Every checked prompt, together with the last 2,000 characters of Claude's previous answer,
  is sent to Anthropic in that separate request: the same provider as the chat itself. The mod
  keeps the answer only in memory until `/clear` and stores or logs nothing.
- The check is told to leave out client names, people's names, URLs, secrets and one-off
  details, but that is best effort: **read every rule before you save it**, and edit it when
  needed.
- **The project `CLAUDE.md` is usually committed**, so a rule saved there is visible to
  everyone with access to the repository.
- **The global `CLAUDE.md` applies to all your projects.** Keep client details out of it, so
  one client's specifics never travel into another client's work.

## License

MIT
