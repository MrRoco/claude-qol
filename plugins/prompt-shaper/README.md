# prompt-shaper

Turns a long, loose prompt into a clear brief before it reaches Claude.

- **Held before sending.** When you type a prompt of 600 characters or more (a setting) and
  press Enter, it is not sent. A row above the prompt says `◇ prompt-shaper · reading your
prompt…`.
- **A few questions.** A small side request, separate from the chat, reads the prompt and looks
  for at most three things that are missing, unclear or contradict each other. Each question
  shows in the row with a text field: type an answer and press Enter, or use **Skip** or
  **Skip all**. If nothing important is missing, there are no questions.
- **A brief in the prompt box.** A second side request rewrites the prompt into a brief with
  the sections `## Task`, `## Context`, `## Constraints` and `## Done when`, in the language you
  wrote in, using your answers. It lands in the prompt box for you to read, edit and send
  yourself. If you typed something in the box meanwhile, the brief is added below it.
- **Your text is never lost.** **Cancel** (at any step), a failed request or a `/clear` puts your
  original prompt back in the box. If the box cannot take the text, the row shows it instead,
  with **Close**.

The mod never sends anything to the chat on its own: you always press Enter on the brief.

## Install

```bash
claude plugin marketplace add MrRoco/claude-qol
claude plugin install prompt-shaper@qol
```

## Use

- **Send as is:** start a prompt with `>>` to skip shaping. The marker (and one space after it)
  is removed, the rest is sent unchanged, however long.
- **On demand:** `/shape <your prompt>` shapes any text, also a short one. Without text it shows
  how to use it; while a prompt is being shaped it says it is busy.
- Only prompts you type (or paste) in the prompt box while Claude is idle are caught. Slash
  commands, prompts with images or files, prompts queued while Claude works, and prompts from
  other sources (task notifications, other mods, `claude -p`) pass untouched.

## Settings

In Claude Code's config menu, or under `pluginConfigs` for `prompt-shaper` in your settings:

| Setting                         | Option      | Default | Notes                                         |
| ------------------------------- | ----------- | ------- | --------------------------------------------- |
| Catch prompts from (characters) | `minLength` | 600     | Below 100, or not a number, falls back to 600 |
| Model for shaping               | `model`     | `haiku` | `haiku` or `sonnet`                           |

## Cost

Each caught prompt makes two small requests on the chosen model (one for the questions, one
for the brief); a prompt with no questions still makes both. On `haiku` that is well under one
cent per prompt; `sonnet` costs more. The requests are billed to the same account as your chat
and show in `/usage` as mod model calls.

## Privacy

- Your prompt, your answers and the name of the project folder (not its path or files) are sent
  to Anthropic in those two requests: the same provider your chat already uses. If your prompt
  holds client data, it goes where your chat messages go anyway.
- The prompt is kept only in the running mod's memory until the brief is in the box or the run
  ends. Nothing is written to disk, logged or stored; the toasts are fixed texts.

## Limits

- Reloading the mod while a prompt is being shaped loses that run: the row then says so and
  offers **Close**. Your prompt may need to be typed again.
- Whether the prompt box keeps your text by itself after the prompt is held depends on Claude
  Code; if it does, the brief is added below your original rather than replacing it.
