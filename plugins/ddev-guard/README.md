# ddev-guard

Makes sure PHP tooling runs inside the DDEV container, not on your machine.

- **Only in DDEV projects.** The mod acts when the project folder has `.ddev/config.yaml`.
  Everywhere else nothing changes.
- **Rewritten, not refused.** When Claude runs `php`, `composer`, `./artisan`, `vendor/bin/<tool>`
  or `./vendor/bin/<tool>` through Bash, the mod puts `ddev exec` in front, so
  `php artisan migrate` runs as `ddev exec php artisan migrate`. Each part of a chained command
  (`&&`, `||`, `;`, `|`, a new line) is looked at on its own.
- **Claude is told.** A rewritten call carries a short note for Claude naming the original and
  the rewritten command, so it uses `ddev exec` itself from then on. You do not see the note.
- **Subfolders follow.** `ddev exec` starts in the container's project folder
  (`/var/www/html`). When the shell is already in a subfolder of the project, say `web`, the
  rewrite becomes `ddev exec --dir /var/www/html/web …`; `cd app && …` adds to that
  (`/var/www/html/web/app`). When the shell is outside the project folder, the command runs
  unchanged. A `cd` to anything other than a plain folder inside the project (an absolute path,
  `..`, `~`, a variable or quoted path) stops the rewrite for the rest of the command, and so does
  an `||` after a `cd`, because the shell may then be in either folder.
- **Your words stay.** The mod only adds `ddev exec` (and `--dir`) in front of a part; it never
  removes or changes what was written.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install ddev-guard@qol
```

## Left alone

- Commands that already start with `ddev`, and parts starting with an assignment
  (`FOO=1 php …`), `sudo`, `env`, `command` or `exec`.
- Anything in quotes, `$( … )`, backticks or a subshell `( … )`, also when they nest
  (`"$(printf "…; php …")"`).
- Anything after a `#` comment.
- Heredocs: a command with `<<` is only rewritten in the parts before the part that holds the
  marker, so a heredoc body is never touched.
- A command the mod cannot read with certainty (an open quote or bracket) runs unchanged.
- Other tools such as `npm`, `node`, `mysql`, `drush` or `wp`, and commands run from a script
  file.

The mod does not check that `ddev` is installed or that the project is started; if it is not,
the rewritten command fails with DDEV's own message. It reads nothing but whether
`.ddev/config.yaml` exists and which folder the shell is in, and it does not store or log
commands.
