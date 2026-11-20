# mod-switch

One place to see which mods you have and turn them on or off, without editing settings by hand.

- **A Mods pane.** `/mods` opens a pane with one row per installed mod: its name, marketplace,
  version and a short description. A mod is a plugin with a hooks module; plugins that only
  bring skills, commands or MCP servers are left out. Mods from any marketplace are listed,
  and so are mods loaded with `--plugin-dir`.
- **On or off for every chat.** Each row has a button that reads `● on` or `○ off`. Pressing
  it changes the setting in the same scope the mod was installed in (user, project or local),
  so the change holds in every new chat, not just this one.
- **Reload when you are ready.** A switch does not touch the running chat. The pane then shows
  `Changes apply to new chats.` with **Reload now**, which reloads the plugins of this chat so
  the change takes effect here too.
- **Sets.** **Save as set** stores which mods are on right now under a name you choose (for
  example `recording`). **Apply** on a saved set switches only the mods that differ from it,
  one at a time; mods in the set that are no longer installed are skipped and named.
  **Delete** removes a set. Saving under an existing name asks you to submit it a second time
  before it replaces the old set.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install mod-switch@qol
```

## Rows you cannot switch

Some rows show a reason instead of a button:

- `managed`: the mod is required or installed by your organization; its settings win over
  yours, so the pane does not try.
- `session only`: the mod was loaded with `--plugin-dir` for this session. There is no setting
  to change; start Claude Code without the flag to leave it out.
- `this mod`: mod-switch itself. Turning it off from its own pane would close the pane; use
  `claude plugin disable mod-switch@qol` instead.

## How it works

Claude Code gives mods no way to change which plugins are enabled, so mod-switch uses the
official `claude` command line, with fixed arguments and no shell:

- `claude plugin list --json` to list what is installed (when `/mods` opens or you press
  **Try again**);
- `claude plugin enable <id> --scope <scope> --json` or `claude plugin disable ...` when you
  press a button or apply a set.

The id and scope are checked before anything runs. To tell mods from other plugins and show a
description, the pane reads two files in each installed plugin's folder:
`hooks/hooks.json` and `.claude-plugin/plugin.json`. It writes no files itself.

Saved sets are kept in the mod's own storage, as set names and plugin ids only.

## Limits

- The `claude` command must be on your `PATH`. If it fails, the pane shows the first line of
  the error with **Try again**.
- A mod switched from another place (the `/plugin` menu, another terminal) shows its new state
  the next time you open `/mods`.
- The pane does not show a mod's errors or skipped hooks: Claude Code does not pass those on to
  other mods.
