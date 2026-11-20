# privacy-mask

Hides personal details and secrets on screen while you record or share your screen. With
masking on, matching text in the transcript is drawn as a bar (`██████`), always the same
length, so the bar gives away nothing about what it covers.

Masking changes only what is drawn. Claude still reads the real text, and nothing about what is
sent to Anthropic changes.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install privacy-mask@qol
```

## Use

- `/mask` switches masking on or off. While it is on, the label `masked` shows at the right of
  the prompt footer, so you can check it before you start recording.
- The switch stays as it is until you use `/mask` again, also after `/clear` or a reload of the
  mod. Only when a `/clear` and a reload of the mod both happen can it fall back to off; the
  missing `masked` label shows that.
- Add names to hide (clients, colleagues) in the mod's settings under **Names to mask**, one
  name per entry. Names are matched as whole words in any case; names of one character are
  ignored.

## What is masked

- Email addresses
- Phone numbers: Dutch (`06-12345678`, `020 123 4567`, `(020) 123 4567`) and international
  (`+31 6 …`, `0031 6 …`), 9 digits or more
- Money amounts with a currency sign or code (`€ 1.234,56`, `$99.95`, `1,234 EUR`)
- IBANs that pass the bank check digits, in any case
- Dutch BSN numbers that pass the 11-check
- A Dutch postcode followed by a house number (`1234 AB 12`, `1234ab 12`); a postcode alone stays visible
- Secrets: common key prefixes (`sk-`, `sk_live_`, `sk_test_`, `ghp_`, `xoxb-`, `AKIA`, `glpat-`
  and similar), `Bearer` tokens, JWTs, and the value of `NAME=value`, `"name": "value"` or a
  YAML line `name: value` where the name holds key, token, secret, pass or pwd. In tool calls,
  a field with such a name is hidden whole.
- The names from your list

Masking errs on the side of hiding: a shell variable such as `$1` or a nine-digit order number
that happens to pass the 11-check can be masked too.

It covers your messages, Claude's answers, tool calls and their output, slash command output,
notices under the logo, subagent rows and the spinner text. Folded tool groups are unfolded
while masking is on, because their summary line cannot be masked.

## What is not covered

Masking is a screen aid, not a guarantee. These still show the real text:

- The prompt box while you type
- Permission dialogs
- The status line
- Rows, panes and toasts from other mods
- Thinking
- `/export` and anything outside the screen (logs, SDK output)
- Rows already printed in the terminal's scrollback before you switched masking on
- A teammate's message drawn as several blocks or with a summary line
- A subagent's name in its row (only the row's label and body are masked)
- Values under `base64` keys in tool output (image data)

**Always check a recording before you share it.**

If masking a row fails while masking is on, the row shows `█ masked content could not be drawn`
instead of its content.

## Privacy

The mod keeps one value: whether masking is on. It stores no transcript text, writes nothing to
disk, logs or the network. Your names list lives in your Claude Code settings.

## License

MIT
