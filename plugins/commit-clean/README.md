# commit-clean

Keeps the commit messages Claude writes in your format: no AI attribution, and a conventional
commit subject.

- **Attribution taken out.** When Claude runs `git commit` with a `Co-Authored-By:` line (or a
  `--trailer`) naming a Claude model (`Claude Opus`, `Sonnet`, `Haiku`, `Fable` or `Code`) or an
  `@anthropic.com` address, or a short "Generated with … Claude Code" trailer line (with an
  emoji or link, or starting with "Generated with"), those lines are removed before the commit
  runs. Claude is told, so it leaves them out next time. A co-author who is a person named
  Claude, and a body sentence that mentions Claude Code, stay.
- **Subject checked.** A subject that is not `type(scope): summary` is refused with a hint, and
  nothing is committed; Claude writes it again. `Updated the importer` is refused;
  `fix(importer): handle empty rows` is fine.
- **Your words stay.** Human co-authors, other trailers (`Refs:`, `Signed-off-by:`) and the body
  stay exactly as written. The mod only removes lines; it never adds text.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install commit-clean@qol
```

## Use

Nothing to do: it works on every `git commit` Claude runs through Bash, also in a chain such as
`git add . && git commit -m "…"` (only the commit is changed).

A subject passes when it:

- starts with one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
  `chore`, `revert`, an optional `(scope)` in lowercase, an optional `!`, then `: ` and text;
- is at most 72 characters (a setting);
- does not end with a period;
- is in the imperative mood: the summary does not start with `added`, `adds`, `fixed`, `fixes`,
  `updated`, `updates`, `removed`, `removes`, `changed` or `changes`.

Git's own subjects pass as well: `Merge branch …`, `Merge pull request …`,
`Merge remote-tracking branch …` and `Revert "…"`.

The message is read from `-m "…"`, `-m '…'`, `--message=…` (several `-m` are paragraphs), from
`-m "$(cat <<'EOF' … EOF)"`, from `-F - <<'EOF' … EOF` and from
`cat <<'EOF' | git commit -F -`.

These pass untouched: `git commit --amend --no-edit`, `-F <file>`, `-C`/`-c <commit>`,
`--fixup`, `--squash`, a commit without a message (the editor opens), and anything that is not
a `git commit`.

## Settings

In Claude Code's config menu, or under `pluginConfigs` for `commit-clean` in your settings:

| Setting                      | Option             | Default | Notes                                       |
| ---------------------------- | ------------------ | ------- | ------------------------------------------- |
| Longest subject (characters) | `maxSubjectLength` | 72      | Below 50, or not a number, falls back to 72 |

## Privacy

Commit messages may name people. The mod reads the command in memory only; nothing is written
to disk, logged, stored or shown. It makes no network calls and runs no commands of its own.

## Limits

- Only commits Claude makes through the Bash tool. Commits you make in your own terminal, git
  hooks, and the default messages of `git merge` or `git revert` are not checked.
- A message the shell would expand (`-m "$SUBJECT"`, an unquoted heredoc with `$`) or a form the
  parser does not know passes unchanged. So does any command the parser fails on: a bug in the
  mod never blocks a commit.
- These forms pass unchecked: an attached `-m"$(…)"` without a space, a commit with a variable
  in front (`VAR=x git commit …`), and `sudo git commit …`.
- Pull request bodies are not checked.
