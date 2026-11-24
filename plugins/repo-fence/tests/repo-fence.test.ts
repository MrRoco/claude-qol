import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

const ROOT = "/Users/dev/work/project";
const OTHER = "/Users/dev/work/other";
const FAILED = "repo-fence could not check this change; it was refused.";

// The test runtime has a timer; the hooks' typings (es2023 only) name none.
const { setTimeout: later } = globalThis as unknown as {
  setTimeout: (run: () => void, ms: number) => unknown;
};

/** Lets calls in flight run up to where they wait. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) {
    await new Promise<void>((resolve) => later(resolve, 0));
  }
};

const question = (path: string): string =>
  `repo-fence: Claude wants to change ${path}, outside this session's repository (${ROOT}). Allow it?`;
const denied = (path: string, root = ROOT): string =>
  `repo-fence: ${path} is outside this session's repository (${root}) and was not allowed. To work there, ask the person to open a Claude Code session in that folder.`;
const allowFolder = (folder: string): string =>
  `Allow ${folder} for this session`;

type Asked = { question: string; options: string[] };

type World = {
  asked: Asked[];
  ran: string[];
  toasts: string[];
  // How the next questions are answered: a label, or null to dismiss.
  answers: (string | null)[];
  // While set, each question waits for `release`.
  isHolding: boolean;
  release: () => void;
  isRootBroken: boolean;
  root: string;
};

/** Stands in for the engine beneath the mod and records what it asked. */
const world = (on: On): World => {
  const waiting: (() => void)[] = [];
  const result: World = {
    asked: [],
    ran: [],
    toasts: [],
    answers: [],
    isHolding: false,
    release: () => waiting.shift()?.(),
    isRootBroken: false,
    root: ROOT,
  };

  on("session.root", () => {
    if (result.isRootBroken) {
      throw new Error("no root");
    }

    return { value: result.root };
  });
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("ui.toast", (_, e) => {
    result.toasts.push(e.text);

    return { value: undefined };
  });
  // `$.ui.ask` is a call of AskUserQuestion; the checked tools land here too.
  on("tool.call", async (_, e) => {
    if (e.tool === "AskUserQuestion") {
      const asked = e.questions[0];
      result.asked.push({
        question: asked?.question ?? "",
        options: (asked?.options ?? []).map((option) => option.label),
      });

      if (result.isHolding) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }

      const answer = result.answers.shift() ?? null;

      if (answer === null) {
        return { deny: "The user dismissed the question." };
      }

      return {
        result: {
          questions: e.questions,
          answers: { [asked?.question ?? ""]: answer },
        },
      } as never;
    }

    const input = e as unknown as Record<string, unknown>;
    result.ran.push(
      String(input.file_path ?? input.notebook_path ?? input.command ?? ""),
    );

    return { result: { ok: true } } as never;
  });

  return result;
};

const edit = ($: Engine, path: string) =>
  $.tool.call({
    tool: "Edit",
    file_path: path,
    old_string: "a",
    new_string: "b",
  });

const write = ($: Engine, path: string) =>
  $.tool.call({ tool: "Write", file_path: path, content: "x\n" });

const notebook = ($: Engine, path: string) =>
  $.tool.call({
    tool: "NotebookEdit",
    notebook_path: path,
    new_source: "x = 1",
  } as never);

const bash = ($: Engine, command: string) =>
  $.tool.call({ tool: "Bash", command });

const clear = ($: Engine) =>
  $.session.end({ reason: "clear", sessionId: "s1", resume: {} as never });

test("changes inside the root, in temp folders and under .claude pass without asking", async ($, on) => {
  const engine = world(on);
  const paths = [
    `${ROOT}/src/a.ts`,
    "src/relative.ts",
    `${ROOT}/./src/../b.ts`,
    "/tmp/scratch.txt",
    "/private/tmp/claude-501/x.md",
    "/var/folders/ab/T/y.json",
    "/private/var/folders/ab/T/z.json",
    "/Users/dev/.claude/settings.json",
    "~/.claude/projects/memory.md",
  ];

  for (const path of paths) {
    expect((await edit($, path)).deny).toBeUndefined();
    expect((await write($, path)).deny).toBeUndefined();
    expect((await notebook($, path)).deny).toBeUndefined();
  }

  expect(engine.asked).toEqual([]);
  expect(engine.ran.length).toBe(paths.length * 3);
});

test(
  "folders in allowedPaths pass without asking",
  { options: { allowedPaths: ` ${OTHER} , ~/shared/,relative/ignored` } },
  async ($, on) => {
    const engine = world(on);

    expect((await edit($, `${OTHER}/app/Foo.php`)).deny).toBeUndefined();
    expect((await write($, "/Users/dev/shared/notes.md")).deny).toBeUndefined();
    expect(engine.asked).toEqual([]);

    // A folder only matches whole: `other-x` is not inside `other`.
    engine.answers.push("Deny");
    expect((await edit($, `${OTHER}-x/a.php`)).deny).toBe(
      denied(`${OTHER}-x/a.php`),
    );
    expect(engine.asked.length).toBe(1);
  },
);

test("an edit outside asks; Allow once runs it and asks again next time", async ($, on) => {
  const engine = world(on);
  const path = `${OTHER}/app/Foo.php`;
  engine.answers.push("Allow once", "Allow once");

  expect((await edit($, path)).deny).toBeUndefined();
  expect(engine.asked).toEqual([
    {
      question: question(path),
      options: ["Allow once", allowFolder(`${OTHER}/app`), "Deny"],
    },
  ]);
  expect(engine.ran).toEqual([path]);

  expect((await edit($, path)).deny).toBeUndefined();
  expect(engine.asked.length).toBe(2);
});

test("Allow folder runs it and stops further asks in that folder", async ($, on) => {
  const engine = world(on);
  engine.answers.push(allowFolder(`${OTHER}/app`));

  expect((await edit($, `${OTHER}/app/Foo.php`)).deny).toBeUndefined();
  expect((await write($, `${OTHER}/app/sub/Bar.php`)).deny).toBeUndefined();
  expect((await bash($, `rm ${OTHER}/app/old.php`)).deny).toBeUndefined();
  expect(engine.asked.length).toBe(1);
  expect(engine.ran.length).toBe(3);

  // A sibling folder is still asked.
  engine.answers.push("Deny");
  expect((await edit($, `${OTHER}/lib/x.php`)).deny).toBe(
    denied(`${OTHER}/lib/x.php`),
  );
  expect(engine.asked.length).toBe(2);
  await clear($);
});

test("Deny, a dismissed question and free text refuse with the deny text", async ($, on) => {
  const engine = world(on);
  const path = `${OTHER}/Foo.php`;
  engine.answers.push("Deny", null, "sure, go ahead");

  for (let i = 0; i < 3; i += 1) {
    expect(await edit($, path)).toEqual({ deny: denied(path) });
  }

  expect(engine.asked.length).toBe(3);
  expect(engine.ran).toEqual([]);
});

test("a rejected ask (headless) refuses with the deny text", async ($, on) => {
  const engine = world(on);
  // No answers queued: each question is dismissed, as in a `-p` run.
  const path = `${OTHER}/book.ipynb`;

  expect(await notebook($, path)).toEqual({ deny: denied(path) });
  expect(await bash($, `cd ${OTHER} && npm i`)).toEqual({
    deny: denied(OTHER),
  });
  expect(engine.ran).toEqual([]);
  expect(engine.toasts).toEqual([]);
});

test("Bash commands that work outside ask", async ($, on) => {
  const engine = world(on);
  const cases: [string, string, string][] = [
    [`cd ${OTHER} && npm i`, OTHER, OTHER],
    [`git -C ${OTHER} commit -m "x"`, OTHER, OTHER],
    [`rm ${OTHER}/x`, `${OTHER}/x`, OTHER],
    [`echo x > ${OTHER}/y`, `${OTHER}/y`, OTHER],
    [`echo x>>${OTHER}/y`, `${OTHER}/y`, OTHER],
    [`npm test 2> ${OTHER}/log.txt`, `${OTHER}/log.txt`, OTHER],
    [`pushd ../other`, OTHER, OTHER],
    [`ls; cp a.txt ~/work/other/b.txt`, `${OTHER}/b.txt`, OTHER],
    [`(cd ${OTHER}/sub; make)`, `${OTHER}/sub`, `${OTHER}/sub`],
    [`npm i --prefix=${OTHER}/`, `${OTHER}`, OTHER],
  ];

  for (const [command, path, folder] of cases) {
    engine.answers.push("Deny");
    expect(await bash($, command)).toEqual({ deny: denied(path) });
    expect(engine.asked.at(-1)?.options[1]).toBe(allowFolder(folder));
  }

  expect(engine.asked.length).toBe(cases.length);
  expect(engine.ran).toEqual([]);
});

test("read-only and inside Bash commands do not ask", async ($, on) => {
  const engine = world(on);
  const commands = [
    `cat ${OTHER}/x`,
    "git -C . status",
    "ls ~/somewhere",
    `grep -r foo ${OTHER} | head -5`,
    `git log ${OTHER}/file`,
    `git -C ${ROOT}/sub diff`,
    "cd src && npm i",
    `rm ${ROOT}/build/old.js`,
    "npm test 2>/dev/null >/tmp/out.txt 2>&1",
    "/usr/bin/env node script.js",
    `echo "${OTHER}" > notes.txt`,
    `cat > notes.md <<EOF\nrm ${OTHER}/x\ncd ${OTHER}\nEOF\nls`,
    `npm i # see ${OTHER}`,
    "source ~/.nvm/nvm.sh",
    ". ~/.nvm/nvm.sh",
    "[ -f ~/.zshrc ] && echo yes",
    `test -d ${OTHER}`,
    "sed -n 1p /etc/hosts",
    `sort ${OTHER}/x | jq . ${OTHER}/y.json`,
    `realpath ${OTHER} && readlink ${OTHER}/link`,
    `find ${OTHER} -name "*.php"`,
  ];

  for (const command of commands) {
    expect((await bash($, command)).deny).toBeUndefined();
  }

  expect(engine.asked).toEqual([]);
  expect(engine.ran).toEqual(commands);
});

test("find with an action that changes or runs something asks", async ($, on) => {
  const engine = world(on);
  const commands = [`find ${OTHER} -delete`, `find ${OTHER} -exec rm {} \\;`];

  for (const command of commands) {
    engine.answers.push("Deny");
    expect(await bash($, command)).toEqual({ deny: denied(OTHER) });
  }

  expect(engine.asked.length).toBe(commands.length);
  expect(engine.ran).toEqual([]);
});

test("attached short options and key=value paths are checked", async ($, on) => {
  const engine = world(on);
  const cases: [string, string, string][] = [
    [`git -C${OTHER} commit -m x`, OTHER, OTHER],
    [`git -C${OTHER} status`, OTHER, OTHER],
    [`make -C${OTHER}`, OTHER, OTHER],
    [`curl -o${OTHER}/x https://example.com`, `${OTHER}/x`, OTHER],
    [`dd if=/dev/zero of=${OTHER}/y`, `${OTHER}/y`, OTHER],
  ];

  for (const [command, path, folder] of cases) {
    engine.answers.push("Deny");
    expect(await bash($, command)).toEqual({ deny: denied(path) });
    expect(engine.asked.at(-1)?.options[1]).toBe(allowFolder(folder));
  }

  expect(engine.asked.length).toBe(cases.length);
  expect(engine.ran).toEqual([]);
});

test("only the home's and the root's .claude folders are always allowed", async ($, on) => {
  const engine = world(on);
  const paths = ["/Users/x/other-client/.claude/settings.json", "/etc/.claude/x"];

  for (const path of paths) {
    engine.answers.push("Deny");
    expect(await edit($, path)).toEqual({ deny: denied(path) });
  }

  expect((await write($, `${ROOT}/.claude/settings.json`)).deny).toBeUndefined();
  expect(engine.asked.length).toBe(paths.length);
});

test("sed -i and sort -o outside ask; other sed and sort do not", async ($, on) => {
  const engine = world(on);
  const cases: [string, string][] = [
    [`sed -i s/a/b/ ${OTHER}/x`, `${OTHER}/x`],
    [`sed -i.bak s/a/b/ ${OTHER}/x`, `${OTHER}/x`],
    [`sed --in-place s/a/b/ ${OTHER}/x`, `${OTHER}/x`],
    [`sort -o ${OTHER}/x a.txt`, `${OTHER}/x`],
  ];

  for (const [command, path] of cases) {
    engine.answers.push("Deny");
    expect(await bash($, command)).toEqual({ deny: denied(path) });
  }

  expect(engine.asked.length).toBe(cases.length);
});

test("a command after a heredoc is still checked", async ($, on) => {
  const engine = world(on);
  engine.answers.push("Deny");

  expect(await bash($, `cat <<'EOF' > x\nbody\nEOF\nrm ${OTHER}/x`)).toEqual({
    deny: denied(`${OTHER}/x`),
  });
  expect(engine.asked.length).toBe(1);
});

test("two parallel calls for one folder open one question", async ($, on) => {
  const engine = world(on);
  engine.isHolding = true;
  engine.answers.push(allowFolder(OTHER));

  const first = edit($, `${OTHER}/a.php`);
  const second = write($, `${OTHER}/b.php`);
  // Let both calls reach the hook before the question is answered.
  await settle();
  // Both wait on the one open question.
  expect(engine.asked.length).toBe(1);
  expect(engine.ran).toEqual([]);
  engine.release();

  expect((await first).deny).toBeUndefined();
  expect((await second).deny).toBeUndefined();
  expect(engine.asked.length).toBe(1);
  expect(engine.ran.sort()).toEqual([`${OTHER}/a.php`, `${OTHER}/b.php`]);
  await clear($);
});

test("/clear empties the session allow-list", async ($, on) => {
  const engine = world(on);
  engine.answers.push(allowFolder(OTHER));

  expect((await edit($, `${OTHER}/a.php`)).deny).toBeUndefined();
  expect((await edit($, `${OTHER}/b.php`)).deny).toBeUndefined();
  expect(engine.asked.length).toBe(1);

  // Another reason keeps the list.
  await $.session.end({
    reason: "other",
    sessionId: "s1",
    resume: {} as never,
  });
  expect((await edit($, `${OTHER}/c.php`)).deny).toBeUndefined();
  expect(engine.asked.length).toBe(1);

  expect(await clear($)).toEqual({ sessionId: "s1" });
  engine.answers.push("Deny");
  expect(await edit($, `${OTHER}/d.php`)).toEqual({
    deny: denied(`${OTHER}/d.php`),
  });
  expect(engine.asked.length).toBe(2);
});

test("an error before deciding refuses the call and toasts", async ($, on) => {
  const engine = world(on);
  engine.isRootBroken = true;

  expect(await edit($, `${ROOT}/src/a.ts`)).toEqual({
    deny: denied(`${ROOT}/src/a.ts`, "unknown"),
  });
  // A Bash command is not named whole in the deny text.
  expect(await bash($, `rm ${OTHER}/x`)).toEqual({
    deny: denied("a path", "unknown"),
  });
  expect(engine.toasts).toEqual([FAILED, FAILED]);
  expect(engine.asked).toEqual([]);
  expect(engine.ran).toEqual([]);
});

test("a ~/ path counts as outside when the home folder is unknown", async ($, on) => {
  const engine = world(on);
  engine.answers.push("Deny");
  // A root under neither /Users nor /home: `~` cannot be placed.
  engine.root = "/srv/project";

  expect(await edit($, "~/notes.md")).toEqual({
    deny: denied("~/notes.md", "/srv/project"),
  });
  expect(engine.asked.length).toBe(1);
});
