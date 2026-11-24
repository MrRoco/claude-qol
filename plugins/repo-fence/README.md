# repo-fence

Keeps Claude inside the session's repository: before it changes a file elsewhere, or works from
another folder in the shell, you are asked first.

- **Asked, not blocked.** When Claude wants to edit `~/development/other-client/app/Foo.php` from
  a session in `~/development/my-project`, a question appears while the change waits:
  **Allow once**, **Allow `<folder>` for this session**, or **Deny**.
- **Deny explains itself.** Claude is told the path is outside this session's repository and
  that it should ask you to open a Claude Code session in that folder.
- **Reading is free.** Only changes are asked: `Edit`, `Write`, `NotebookEdit`, and shell
  commands that write or work elsewhere. `Read`, `Grep`, `Glob` and read-only commands such as
  `cat`, `ls`, `grep` or `git log` never ask.
- **Claude's own places never ask.** Your home's `~/.claude` folder and the repository's own
  `.claude` folder, `/tmp`, `/private/tmp`, `/var/folders`, `/private/var/folders` (scratchpads
  and temp files) and `/dev` (such as `2>/dev/null`).
- **One question per folder.** Calls for the same folder that arrive while a question is open
  wait for that answer instead of opening a second dialog.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install repo-fence@qol
```

## Use

- **Allow once** lets this one change through; the next one there asks again.
- **Allow `<folder>` for this session** lets every change in that folder and below through until
  the session ends or you run `/clear`. Allowed folders are never remembered across sessions.
- **Deny**, closing the dialog, or typing your own answer refuses the change. In a run with no
  one to ask (`claude -p`) every outside change is refused.
- The folder asked about is the file's own folder, or the folder itself for `cd`, `pushd` and
  `git -C`, or for a path written with a trailing `/`.

### What the shell check looks at

A command is split into parts on `&&`, `||`, `;`, `|`, `&` and new lines (not inside quotes or
`$( … )`); heredoc bodies are skipped. A part asks when:

- it is `cd <dir>`, `pushd <dir>` or `git -C <dir> …` (also `git -C<dir>`) with `<dir>` outside;
- it writes with `>` or `>>` to a path outside, whatever the command;
- its command is not read-only and it names an absolute or `~/` path outside (also as
  `--option=/path`, `key=/path` such as `dd of=/path`, or attached as `-o/path`). Read-only:
  `ls`, `cat`, `head`, `tail`, `less`, `grep`, `rg`, `find`, `wc`, `stat`, `file`, `diff`,
  `tree`, `du`, `echo`, `printf`, `which`, `test`, `[`, `realpath`, `readlink`, `jq`, `sort`,
  `sed -n` with a plain print script (`1p`, `10,20p`, `/re/p`), and `git log`, `show`, `diff`,
  `status`, `blame`. Not read-only after all: `find` with `-delete`, `-exec`, `-execdir`, `-ok`,
  `-okdir`, `-fprint`, `-fprint0`, `-fprintf` or `-fls`; `sort` with any option outside a
  known-safe set (such as `-o`, `--output`, `-T` or `--compress-program`); `tree` with `-o` or
  `--output`; `git` with `--output…`, or with `-c` or `--config-env` before the subcommand; any
  other `sed` (such as `-i`, `-f` or a script with `s`, `w` or `e`), where a file named after
  `w` in the script is checked too. `source` and `.` run a script, so a script outside asks.

## Settings

In Claude Code's config menu, or under `pluginConfigs` for `repo-fence` in your settings:

| Setting                | Option         | Default | Notes                                                          |
| ---------------------- | -------------- | ------- | -------------------------------------------------------------- |
| Always allowed folders | `allowedPaths` | (empty) | Comma-separated, absolute or `~/...`; relative entries ignored |

`~/` is read as the home folder the session's repository lives under (`/Users/<name>` or
`/home/<name>`). For a repository elsewhere, a `~/` path counts as outside.

## Privacy

- Paths may name clients. They are only shown to you in the question and, on a refusal, sent to
  Claude in the deny text. Nothing is logged, written to disk or stored; the allowed folders live
  in the running mod's memory only.
- If the check itself fails, the change is refused and a toast says
  `repo-fence could not check this change; it was refused.`

## Limits

This is a guard against mistakes, not a sandbox. A command can still reach other folders in
ways the check does not see: a script that writes elsewhere, a path in a variable (`$HOME/x`),
a relative path in a command other than `cd` or `pushd`, a command inside `$( … )` or inside
backticks, `cd ~user`, a bare `cd` (to the home folder), or an MCP tool that writes files.

The `.claude` folders of other projects are not always allowed: a change there asks like any
other outside change.
