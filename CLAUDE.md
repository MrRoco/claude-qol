# claude-qol

A marketplace (`qol`) of quality-of-life mods for Claude Code. Scope, decisions and phase
contracts live in `.plan/` (local only, not committed). Read `.plan/scope.md` before changing
anything when it exists.

## Clean room (non-negotiable)

These mods are independent rebuilds of features seen elsewhere. Never open third-party mod
source, in particular anything under `plugins/` in `~/.claude/local-marketplaces/benai-mods/`
or `~/.claude/plugins/cache/benai-mods/`. Build only from the phase contract, the official docs
(<https://code.claude.com/docs/en/plugins/mods/overview.md>) and the generated type files in a
mod's `.claude-plugin/types/`. The full rule is non-negotiable 1 in `.plan/scope.md`.

## Layout

```text
.claude-plugin/marketplace.json   the qol marketplace, one entry per mod
plugins/<name>/
  .claude-plugin/plugin.json      name, version, description, author MrRoco, license MIT
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              the hooks module
  types/index.d.ts                $.state contract, when the mod keeps state ("types" in plugin.json)
  tests/<name>.test.ts(x)         run with claude plugin test
  README.md
scripts/check.sh                  validate and test everything
```

## Commands

```bash
claude --plugin-dir ./plugins/<name>   # develop one mod with hot reload
scripts/check.sh                       # validate the marketplace and every mod, run all tests
```

## Rules

- Least privilege: a mod only calls the mods API methods it needs. Every `$.process.*`,
  `$.fs.write`, `$.http.fetch` or `$.mcp.call` must be justified in the phase contract.
- No secrets or personal data written to disk or logs unless the contract says so.
- Plugin names never start with `claude-`.
- Own names, texts and look. Never reuse another mod's names or UI texts.
- Generated files (`.claude-plugin/types/`, a generated `tsconfig.json`) are not committed.
- Commits: conventional commit format, imperative mood, no AI attribution trailers.
- Tested on Claude Code 2.1.328.

## Phase contracts

- `.plan/phase0-contract.md` — marketplace skeleton
- `.plan/phase1-contract.md` — task-bar
