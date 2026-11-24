import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

const NOTE =
  "commit-clean removed AI attribution lines from the commit message. Leave them out of commit messages in this project.";
const CO_AUTHOR = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
const GENERATED =
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)";

const hint = (subject: string, maxLength = 72): string =>
  `commit-clean: the subject "${subject}" is not in the project's commit format. ` +
  `Use "type(scope): summary" in the imperative mood (types: feat, fix, docs, style, ` +
  `refactor, perf, test, build, ci, chore, revert), at most ${maxLength} characters, ` +
  `no period at the end. Nothing was committed.`;

/** Claude Code's usual commit form: the message in a heredoc inside `-m`. */
const heredocCommit = (message: string): string =>
  `git commit -m "$(cat <<'EOF'\n${message}\nEOF\n)"`;

/** Stands in for the shell beneath the mod: records each command that ran. */
const world = (on: On): { ran: string[] } => {
  const result = { ran: [] as string[] };

  on("tool.call", (_, e) => {
    if (e.tool === "Bash") {
      result.ran.push(e.command);
    }

    return { result: { stdout: "", stderr: "", interrupted: false } };
  });

  return result;
};

const bash = ($: Engine, command: string) =>
  $.tool.call({ tool: "Bash", command });

test("-m with a Claude Co-Authored-By line: removed, run, noted", async ($, on) => {
  const shell = world(on);

  const out = await bash(
    $,
    `git commit -m "feat: add importer\n\n${CO_AUTHOR}"`,
  );

  expect(shell.ran).toEqual(['git commit -m "feat: add importer"']);
  expect(out.context).toEqual([NOTE]);
});

test("the heredoc form inside -m: the line is removed", async ($, on) => {
  const shell = world(on);

  const out = await bash(
    $,
    heredocCommit(`feat: x\n\nSome body text.\n\n${CO_AUTHOR}`),
  );

  expect(shell.ran).toEqual([heredocCommit("feat: x\n\nSome body text.")]);
  expect(out.context).toEqual([NOTE]);
});

test("-F - with a heredoc: the line is removed", async ($, on) => {
  const shell = world(on);

  const out = await bash(
    $,
    `git commit -F - <<'EOF'\nfix(api): handle empty rows\n\n${CO_AUTHOR}\nEOF`,
  );

  expect(shell.ran).toEqual([
    "git commit -F - <<'EOF'\nfix(api): handle empty rows\nEOF",
  ]);
  expect(out.context).toEqual([NOTE]);
});

test("a Generated with Claude Code line, with emoji or link, is removed", async ($, on) => {
  const shell = world(on);

  await bash($, heredocCommit(`feat: x\n\n${GENERATED}`));
  await bash(
    $,
    `git commit -m 'docs: add usage' -m 'Generated with Claude Code'`,
  );
  const out = await bash(
    $,
    heredocCommit(
      `chore: bump\n\nGenerated with [Claude Code](https://claude.ai/code)\n\n${CO_AUTHOR}`,
    ),
  );

  expect(shell.ran).toEqual([
    heredocCommit("feat: x"),
    "git commit -m 'docs: add usage'",
    heredocCommit("chore: bump"),
  ]);
  expect(out.context).toEqual([NOTE]);
});

test("an anthropic.com co-author and any casing are removed", async ($, on) => {
  const shell = world(on);

  await bash(
    $,
    `git commit -m "feat: x" -m "co-authored-by: Bot <bot@anthropic.com>"`,
  );
  await bash(
    $,
    `git commit --message="feat: y\n\nCO-AUTHORED-BY: claude <x@y.z>"`,
  );

  expect(shell.ran).toEqual([
    'git commit -m "feat: x"',
    'git commit --message="feat: y"',
  ]);
});

test("a human co-author, other trailers and the body stay", async ($, on) => {
  const shell = world(on);
  const message =
    "fix(importer): handle empty rows\n\nSkip rows without an order number.\n\n" +
    "Refs: SUP-123\nCo-Authored-By: Jane Doe <jane@example.com>";

  await bash($, heredocCommit(`${message}\n${CO_AUTHOR}`));
  const untouched = await bash($, heredocCommit(message));

  expect(shell.ran).toEqual([heredocCommit(message), heredocCommit(message)]);
  expect(untouched.context).toBeUndefined();
});

test("a good subject without trailers passes unchanged, without a note", async ($, on) => {
  const shell = world(on);
  const commands = [
    'git commit -m "feat(task-bar): show the model"',
    "git commit -am 'fix!: drop the old flag'",
    'git -C repo -c user.name=x commit -m "refactor: split the parser" -m "Body."',
    heredocCommit("docs: add live test cases\n\nA body."),
  ];

  for (const command of commands) {
    const out = await bash($, command);
    expect(out.context).toBeUndefined();
    expect(out.deny).toBeUndefined();
  }

  expect(shell.ran).toEqual(commands);
});

test("a bad subject is denied with the hint and nothing runs", async ($, on) => {
  const shell = world(on);
  const long = `feat: ${"a".repeat(67)}`;
  expect(long.length).toBe(73);

  expect(await bash($, 'git commit -m "Updated the importer"')).toEqual({
    deny: hint("Updated the importer"),
  });
  expect(await bash($, 'git commit -m "feat: add x."')).toEqual({
    deny: hint("feat: add x."),
  });
  expect(await bash($, `git commit -m "${long}"`)).toEqual({
    deny: hint(long),
  });
  expect(await bash($, heredocCommit("fix: fixed y"))).toEqual({
    deny: hint("fix: fixed y"),
  });
  expect(await bash($, "git commit -m 'feat: Adds z'")).toEqual({
    deny: hint("feat: Adds z"),
  });
  expect(await bash($, "git commit -m 'Feat: add z'")).toEqual({
    deny: hint("Feat: add z"),
  });

  expect(shell.ran).toEqual([]);
});

test("the subject is checked after the trailers are removed", async ($, on) => {
  const shell = world(on);

  expect(
    await bash($, heredocCommit(`Updated things\n\n${CO_AUTHOR}`)),
  ).toEqual({
    deny: hint("Updated things"),
  });
  expect(shell.ran).toEqual([]);
});

test("amend without edit, a message file, no message, git log and echo pass unchanged", async ($, on) => {
  const shell = world(on);
  const commands = [
    "git commit --amend --no-edit",
    "git commit -F msg.txt",
    "git commit --file=msg.txt",
    "git commit",
    "git commit -a",
    "git commit -C HEAD",
    "git commit --fixup=abc123",
    "git commit --squash abc123",
    "git log --oneline -5",
    'echo "git commit -m \\"Updated the importer\\""',
    `echo "git commit -m 'wip\n\n${CO_AUTHOR}'"`,
  ];

  for (const command of commands) {
    const out = await bash($, command);
    expect(out.deny).toBeUndefined();
    expect(out.context).toBeUndefined();
  }

  expect(shell.ran).toEqual(commands);
});

test("git add . && git commit -m: only the commit segment is changed", async ($, on) => {
  const shell = world(on);

  const out = await bash(
    $,
    `git add . && git commit -m "feat: add x\n\n${CO_AUTHOR}" && git push`,
  );

  expect(shell.ran).toEqual([
    'git add . && git commit -m "feat: add x" && git push',
  ]);
  expect(out.context).toEqual([NOTE]);
});

test("a bad subject in one segment of a chain denies the whole call", async ($, on) => {
  const shell = world(on);

  expect(await bash($, 'git add . && git commit -m "wip"')).toEqual({
    deny: hint("wip"),
  });
  expect(shell.ran).toEqual([]);
});

test(
  "a custom longest subject is used",
  { options: { maxSubjectLength: 50 } },
  async ($, on) => {
    const shell = world(on);
    const fifty = `feat: ${"a".repeat(44)}`;
    const fiftyOne = `${fifty}b`;

    expect((await bash($, `git commit -m "${fifty}"`)).deny).toBeUndefined();
    expect(await bash($, `git commit -m "${fiftyOne}"`)).toEqual({
      deny: hint(fiftyOne, 50),
    });
    expect(shell.ran).toEqual([`git commit -m "${fifty}"`]);
  },
);

test(
  "a longest subject below 50 falls back to 72",
  { options: { maxSubjectLength: 20 } },
  async ($, on) => {
    const shell = world(on);
    const seventyTwo = `feat: ${"a".repeat(66)}`;
    const seventyThree = `${seventyTwo}b`;

    expect(
      (await bash($, `git commit -m "${seventyTwo}"`)).deny,
    ).toBeUndefined();
    expect(await bash($, `git commit -m "${seventyThree}"`)).toEqual({
      deny: hint(seventyThree),
    });
    expect(shell.ran).toEqual([`git commit -m "${seventyTwo}"`]);
  },
);

// A setting that is not a number never reaches the mod: the host refuses to
// load options that do not fit plugin.json's userConfig.

test("a throw inside the parser passes the call unchanged", async ($, on) => {
  const shell = world(on);
  // An unterminated quote and nesting past the limit both make the parser throw.
  const unterminated = `git commit -m "Updated it\n\n${CO_AUTHOR}`;
  const deep = `git commit -m "${"$(".repeat(40)}x${")".repeat(40)}"`;

  for (const command of [unterminated, deep]) {
    const out = await bash($, command);
    expect(out.deny).toBeUndefined();
    expect(out.context).toBeUndefined();
  }

  expect(shell.ran).toEqual([unterminated, deep]);
});

test("a message the shell would expand passes unchanged", async ($, on) => {
  const shell = world(on);
  const command = `git commit -m "$SUBJECT\n\n${CO_AUTHOR}"`;

  await bash($, command);
  expect(shell.ran).toEqual([command]);
});

test("a refused run beneath is returned as is, without a note", async ($, on) => {
  on("tool.call", () => ({ deny: "blocked below" }));

  expect(await bash($, `git commit -m "feat: x\n\n${CO_AUTHOR}"`)).toEqual({
    deny: "blocked below",
  });
});

test("other tools are not touched", async ($, on) => {
  const seen: string[] = [];
  on("tool.call", (_, e) => {
    seen.push(String(e.tool));

    return { result: { file: { content: "" } } } as never;
  });

  await $.tool.call({ tool: "Read", file_path: "/tmp/x" } as never);
  expect(seen).toEqual(["Read"]);
});
