# project-badge

Shows what kind of project a session is in, and tells Claude the matching working rules once
per session.

- **A badge by the prompt.** At the end of the hint line under the prompt, for example
  `DDEV · MODX 3.0 · PHP 8.2`, `DDEV · Laravel 11 · PHP 8.3`, `DDEV · wordpress · PHP 8.1` or
  `n8n · 4 workflows`. Nothing recognised: no badge.
- **Rules for Claude, once.** The first prompt of the session carries a short block Claude reads
  and you do not see: run PHP tooling with `ddev exec`, the PHP version and docroot, and the
  rules for Laravel, MODX or n8n. After `/clear` it goes along once more. Your prompt text is
  never changed.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install project-badge@qol
```

## What it recognises

Detection runs from the project root when the session starts (and on a reload). Two layers,
combined in one badge:

| Layer       | Recognised by                                                                                | Badge part          |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------- |
| Environment | `.ddev/config.yaml` (its `type`, `php_version` and `docroot`)                                | `DDEV`, `PHP 8.2`   |
| Laravel     | an `artisan` file and an `app/` folder; version from `laravel/framework` in `composer.lock`  | `Laravel 11`        |
| MODX        | `core/config/config.inc.php` or `core/components/`, also under the docroot (else `webroot/`) | `MODX 3.0`          |
| n8n         | JSON files in the root and `workflows/` with a `nodes` list and a `connections` object       | `n8n · 4 workflows` |
| Other DDEV  | DDEV's own `type` when none of the above matches                                             | `wordpress`         |

The first framework that matches wins, in the order of the table. A version that cannot be
found is left out (`MODX`, `Laravel`).

## Use

Nothing to do: open a session in a project. The badge is drawn in the terminal; other surfaces
do not show a hint-line tail yet.

## Privacy

- Only fixed project files are read: `.ddev/config.yaml`, `composer.lock` (under 4 MiB),
  MODX's `core/docs/version.inc.php` and JSON files (under 1 MiB, at most 50) for n8n.
- `config.inc.php` holds database credentials: it is only checked for existence, never opened.
  `.env*`, `auth.json`, `credentials*.json` and `*service-account*.json` files are never opened
  either (in any letter case).
- Nothing outside the project root: before a file is read, or a `core`, docroot or `workflows/`
  folder is trusted, its real path (every symbolic link followed) is checked, and anything that
  lands outside the root is skipped.
- Nothing is written to disk, logged or sent anywhere, except the short rules block that goes
  to Claude with your first prompt (about 100-200 tokens, the same provider as your chat).

## Limits

- Files are read when the session starts or reloads, not watched: a project changed during the
  session shows the old badge until a reload.
- A first prompt sent while detection is still running waits for it at most one second; past
  that it goes without the rules block, and the next prompt takes it.
- `.ddev/config.*.yaml` overrides are not read.
- Other frameworks (Symfony, WordPress plugins, front-end apps) show DDEV's `type`, or nothing
  outside DDEV.
