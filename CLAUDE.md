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
- Spike host capabilities before writing a contract (for example which tools are offered),
  with a short live probe: the test kit raises events a real session may never deliver.
- Always give `tool.call` hooks a tool matcher. A matcher-less one turns off background
  moves, live output and Code Mode's wait for every tool.
- Keep hook counter state synchronous: never check state across an `await`, so parallel
  calls can't race.

## Phase contracts

- `.plan/phase0-contract.md` — marketplace skeleton
- `.plan/phase1-contract.md` — task-bar
- `.plan/phase2-contract.md` — fresh-start
- `.plan/phase3-contract.md` — cache-timer
- `.plan/phase6-contract.md` — chat-ledger
- `.plan/phase5-contract.md` — lesson-saver
- `.plan/phase4-contract.md` — prompt-shaper
- `.plan/phase8-contract.md` — replay-theater
- `.plan/phase7-contract.md` — privacy-mask
- `.plan/phase9-contract.md` — mod-switch
- `.plan/phase10-contract.md` — ddev-guard
- `.plan/phase12-contract.md` — repo-fence
- `.plan/phase13-contract.md` — project-badge
- `.plan/phase11-contract.md` — commit-clean

## Rules from corrections

- When adding or changing plugins, update the test-case markdown with tests for each new plugin. (added 24-11-2026)
