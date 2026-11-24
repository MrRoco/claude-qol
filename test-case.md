# Live test cases

Manual checks for the qol mods in a real Claude Code session. Unit tests run with
`scripts/check.sh`; these cases cover what only a live terminal shows.

## Setup

Install the mods from the marketplace (see `README.md`), turn off any other mods that do the
same job, and test in a scratch project so nothing lands in real work:

```bash
mkdir -p ~/qol-test && cd ~/qol-test && git init -q && claude
```

Keep the terminal at least 120 columns wide for the side-by-side layout above the prompt.

## 1. task-bar, chat-ledger, replay-theater

Prompt:

```text
Create three files: notes.md with a short title, todo.txt with three items, and hello.js that logs "hi". Do it as a 4-step task and keep a progress list. Use two Explore subagents in parallel first to check the folder is empty.
```

Expected:

- [ ] The bar right above the prompt fills to `4/4` and stays until the next prompt.
- [ ] `/crew` shows two Explore cards that end `done`.
- [ ] A hint row says `3 file edits in the last turn`; `/replay` steps through the three diffs.
- [ ] `/ledger` lists the three files as `created` and the subagent calls; **Copy as Markdown**
      pastes cleanly.
- [ ] Context files in `/ledger` stay empty until the mod is approved for
      `cc-plugin-sec-default` (expected).

## 2. lesson-saver

Prompts, one after the other:

```text
Write a function in hello.js that adds two numbers.
```

```text
No, always use const arrow functions in JavaScript, never function declarations.
```

Expected:

- [ ] A bordered card `✎ New lesson` offers a rule.
- [ ] **Save to project** adds it to `CLAUDE.md` under `## Rules from corrections`, ending in
      `(added dd-mm-yyyy)`; `git diff CLAUDE.md` shows only that line.
- [ ] The same correction in other words is not offered again.
- [ ] **Edit** keeps focus in the text field while typing.

## 3. prompt-shaper

Paste as one prompt (558 characters; the default threshold is 400):

```text
ok so I need something for the website, the client wants a contact form but also maybe a newsletter thing, not sure if that should be on the same page, they use some mail service I think mailchimp or maybe brevo, it needs to be GDPR proof obviously and look nice on mobile, oh and the old form sent mails to the wrong address sometimes so that has to be fixed too, also they want to see the submissions somewhere, maybe in the CMS or just by mail, deadline is soon, can you build this for me in a simple way so their own team can maintain it later without us
```

Expected:

- [ ] The prompt is held; up to three questions show in the row, without a field of their own.
- [ ] Type an answer in the prompt box and press Enter: the chat shows
      `prompt-shaper noted answer 1 of 3.`, the box is empty again, the next question shows.
      Skip one.
- [ ] A brief with `## Task`, `## Context`, `## Constraints`, `## Done when` lands in the prompt
      box, in the language of the prompt. It is not sent.
- [ ] Again, but **Skip all** at the first question: tidied text without sections lands in the
      box, with nothing added.
- [ ] While a question is open, `>> what is 2+2` is sent to Claude at once, without the `>>`.
- [ ] **Cancel** sends the original to Claude as is.

## 4. privacy-mask

In `/config`, add `Jansen Bakkerij` under privacy-mask's names. Run `/mask`, then paste:

```text
Summarize this fake record: Jan Jansen of Jansen Bakkerij, jan@example.nl, 06-12345678, (020) 123 4567, IBAN NL91ABNA0417164300, invoice € 1.234,56, address 1234AB 12, API_KEY=sk-test1234567890abcdef, Authorization: Bearer abcdefghijklmnop
```

Expected:

- [ ] Bars in your message and in Claude's answer; a `masked` label in the footer.
- [ ] Asking "what was the email address?" gets the right answer, shown as a bar.
- [ ] `/mask` again: new rows show unmasked.
- [ ] No lag while answers stream.
- [ ] Note what still shows unmasked (prompt box while typing, older scrollback).

## 5. cache-timer

Expected:

- [ ] After an answer, a row counts down with `5 min` or `1 h`; it hides while Claude works.
- [ ] After 3+ minutes idle, **Keep warm** restarts the countdown and shows
      `· kept warm ≈$0.0x`.
- [ ] When the countdown ends, the row says the cache is cold.

## 6. fresh-start

Set fresh-start's threshold to `20000` in `/config`, then keep chatting (case 3's brief is
enough).

Expected:

- [ ] The offer shows at half width, next to cache-timer.
- [ ] **Write handoff** shows the step strip, then a file in `.claude/handoffs/`; `git status`
      does not list it.
- [ ] **Copy** reaches the clipboard.
- [ ] **Start fresh chat** clears the chat and leaves the handoff in the prompt box.
- [ ] Check how the half-width row looks when cache-timer is not showing.

## 7. mod-switch

Expected:

- [ ] `/mods` lists the installed mods with `● on` / `○ off`.
- [ ] Switching `replay-theater` off, then **Reload now**, removes `/replay`; switching it back
      restores it.
- [ ] Save a set `recording`, switch something, apply the set: only the difference switches.
- [ ] A mod installed for another project does not show.

## 8. ddev-guard

Use an existing local DDEV project (running, `ddev start`), for example a MODX or Laravel client
project. These prompts only read; do not run migrations.

Prompts, one at a time:

```text
Run php -v and tell me the PHP version.
```

```text
Run cd core && php -r 'echo getcwd();' and show the output.
```

```text
Run git log --oneline -1 | cat, then composer --version.
```

Expected:

- [ ] `php -v` shows the container's PHP (the `php_version` in `.ddev/config.yaml`), not your
      Mac's. Claude mentions it ran through `ddev exec`.
- [ ] The `cd core` case prints `/var/www/html/core` (the `--dir` from the `cd`).
- [ ] After Claude ran a separate `cd core` earlier in the chat, a bare `php -r 'echo getcwd();'`
      still prints `/var/www/html/core` (current folder carried over).
- [ ] `git log` runs on the host unchanged; only `composer --version` goes through `ddev exec`.
- [ ] Piped input: `echo '<?php echo 1;' | php` prints `1` (stdin reaches the container).
- [ ] In `~/qol-test` (no `.ddev/`), `php -v` runs on the host unchanged.

## 9. commit-clean

In `~/qol-test`:

```text
Create notes.txt with one line, then commit it with a message you choose, ending with your usual Co-Authored-By trailer.
```

```text
Commit an empty change with the subject "Updated the notes".
```

```text
Commit an empty change with subject "docs: add notes" and the body line "Co-Authored-By: Claude Dupont <claude.dupont@example.com>".
```

Expected:

- [ ] `git log -1 --format=%B` shows no `Co-Authored-By: Claude …` and no "Generated with Claude
      Code" line; Claude says commit-clean removed them.
- [ ] "Updated the notes" is refused with the format hint; Claude retries with a subject like
      `docs: update notes` and that commit lands.
- [ ] The human co-author "Claude Dupont" stays in the third commit.

## 10. repo-fence

In `~/qol-test`, with a second folder next to it:

```bash
mkdir -p ~/qol-test-outside && echo hello > ~/qol-test-outside/a.txt
```

Prompts:

```text
Read ~/qol-test-outside/a.txt and tell me what it says.
```

```text
Append the line "world" to ~/qol-test-outside/a.txt.
```

Expected:

- [ ] Reading does not ask.
- [ ] The append shows the repo-fence question with **Allow once**, **Allow … for this
      session** and **Deny**, while Claude waits.
- [ ] **Deny**: nothing changes; Claude says to open a session in that folder.
- [ ] Ask again, pick **Allow … for this session**: the line is added; a second change in that
      folder does not ask.
- [ ] `/clear`, then another change there: it asks again.
- [ ] Writing to `/tmp/qol.txt` or the scratchpad does not ask.

## 11. project-badge

Open Claude in the DDEV project from case 8, in `~/qol-test`, and in a folder with an n8n
workflow export (`.json` with `nodes` and `connections`).

Expected:

- [ ] DDEV + MODX: the hint line under the prompt ends with something like
      `DDEV · MODX 3.0 · PHP 8.2` (dim).
- [ ] DDEV + Laravel: `DDEV · Laravel 11 · PHP 8.3`.
- [ ] n8n folder: `n8n · 1 workflow`.
- [ ] `~/qol-test`: no badge.
- [ ] Ask as first prompt "What kind of project is this and how should you run PHP here?"
      without letting Claude read files: it names the type and `ddev exec`.
- [ ] The first prompt is not noticeably slower than usual.

## Report back

For each failed box: the case number, what you saw, and the terminal width.
