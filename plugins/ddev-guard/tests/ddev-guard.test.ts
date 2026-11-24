import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

const NOTE_END = "Run PHP, Composer and vendor/bin tools with ddev exec.";

type World = {
  // Every command that reached the tool beneath the mod, in order.
  ran: string[];
  // Inputs of non-Bash tools that reached beneath the mod.
  others: { tool: string; command: unknown }[];
};

type Options = {
  root: string;
  isDdev: boolean;
  isExistsThrowing?: boolean;
  // The shell's folder; the root when absent, a throw when "throw".
  cwd?: string;
  // What the tool beneath answers; a plain result when absent.
  answer?: () => unknown;
};

// The detection cache lives per session root for the whole module, so each
// test uses its own root.
let rootCount = 0;
const freshRoot = (): string => {
  rootCount += 1;

  return `/work/project-${rootCount}`;
};

/** Stands in for the engine beneath the mod and records what ran. */
const world = (on: On, options: Options): World => {
  const result: World = { ran: [], others: [] };

  on("session.root", () => ({ value: options.root }));
  on("session.cwd", () => {
    if (options.cwd === "throw") {
      throw new Error("no folder");
    }

    return { value: options.cwd ?? options.root };
  });
  on("fs.exists", (_, e) => {
    if (options.isExistsThrowing === true) {
      throw new Error("disk gone");
    }

    return {
      value: options.isDdev && e.path === `${options.root}/.ddev/config.yaml`,
    };
  });
  on("tool.call", (_, e) => {
    if (e.tool === "Bash") {
      result.ran.push(String(e.command));
    } else {
      result.others.push({ tool: String(e.tool), command: (e as { command?: unknown }).command });
    }

    return (options.answer?.() ?? { result: { ok: true } }) as {
      result: unknown;
    };
  });

  return result;
};

const bash = ($: Engine, command: string) =>
  $.tool.call({ tool: "Bash", command } as unknown as Parameters<
    Engine["tool"]["call"]
  >[0]);

const ddevWorld = (on: On): World =>
  world(on, { root: freshRoot(), isDdev: true });

const noteFor = (original: string, rewritten: string): string =>
  `ddev-guard: this is a DDEV project, so "${original}" ran as "${rewritten}". ${NOTE_END}`;

/** Runs one command and checks it ran as `expected` with the note. */
const expectRewrite = async (
  $: Engine,
  engine: World,
  command: string,
  expected: string,
): Promise<void> => {
  const answer = await bash($, command);
  expect(engine.ran.at(-1)).toBe(expected);
  expect(answer.context).toEqual([noteFor(command, expected)]);
};

/** Runs one command and checks it ran unchanged without a note. */
const expectUnchanged = async (
  $: Engine,
  engine: World,
  command: string,
): Promise<void> => {
  const answer = await bash($, command);
  expect(engine.ran.at(-1)).toBe(command);
  expect(answer.context ?? []).toEqual([]);
};

test("php, composer, artisan and vendor/bin run through ddev exec", async ($, on) => {
  const engine = ddevWorld(on);

  await expectRewrite($, engine, "php -v", "ddev exec php -v");
  await expectRewrite(
    $,
    engine,
    "composer install",
    "ddev exec composer install",
  );
  await expectRewrite(
    $,
    engine,
    "./artisan migrate",
    "ddev exec ./artisan migrate",
  );
  await expectRewrite(
    $,
    engine,
    "vendor/bin/phpunit",
    "ddev exec vendor/bin/phpunit",
  );
  await expectRewrite(
    $,
    engine,
    "./vendor/bin/pint --test",
    "ddev exec ./vendor/bin/pint --test",
  );
  await expectRewrite(
    $,
    engine,
    "  php artisan migrate",
    "  ddev exec php artisan migrate",
  );
  expect(engine.ran.length).toBe(6);
});

test("every top-level segment is rewritten on its own", async ($, on) => {
  const engine = ddevWorld(on);

  await expectRewrite(
    $,
    engine,
    "composer install && php artisan migrate; vendor/bin/phpunit || echo failed",
    "ddev exec composer install && ddev exec php artisan migrate; ddev exec vendor/bin/phpunit || echo failed",
  );
  await expectRewrite(
    $,
    engine,
    "php -m | grep pdo",
    "ddev exec php -m | grep pdo",
  );
  await expectRewrite(
    $,
    engine,
    "git status\nphp -v",
    "git status\nddev exec php -v",
  );
});

test("the same commands pass unchanged outside a DDEV project", async ($, on) => {
  const engine = world(on, { root: freshRoot(), isDdev: false });

  for (const command of [
    "php -v",
    "composer install",
    "./artisan migrate",
    "vendor/bin/phpunit",
  ]) {
    await expectUnchanged($, engine, command);
  }
});

test("ddev, assignments, sudo, env, command, exec and other words pass unchanged", async ($, on) => {
  const engine = ddevWorld(on);

  for (const command of [
    "ddev exec php -v",
    "ddev composer install",
    "FOO=1 php x",
    "sudo php x",
    "env php x",
    "command php x",
    "exec php x",
    "echo php",
    "phpunit",
    "php-cs-fixer fix",
    "bin/console cache:clear",
    "vendor/bin/",
    "npm run build",
  ]) {
    await expectUnchanged($, engine, command);
  }
});

test("a cd into a project folder adds --dir; any other cd stops the rewrite", async ($, on) => {
  const engine = ddevWorld(on);

  await expectRewrite(
    $,
    engine,
    "cd web && php x | grep y",
    "cd web && ddev exec --dir /var/www/html/web php x | grep y",
  );
  await expectRewrite(
    $,
    engine,
    "cd ./web/ && cd app && composer install",
    "cd ./web/ && cd app && ddev exec --dir /var/www/html/web/app composer install",
  );
  await expectRewrite(
    $,
    engine,
    "php -v && cd /tmp && php x",
    "ddev exec php -v && cd /tmp && php x",
  );

  for (const command of [
    "cd /tmp && php x",
    "cd ../other && php x",
    "cd web/../.. && php x",
    "cd ~/site && php x",
    "cd && php x",
    'cd "my dir" && php x',
    "cd $DIR && php x",
    "cd web; php x",
    "cd web || php x",
  ]) {
    await expectUnchanged($, engine, command);
  }
});

test("quoted words, substitutions and subshells are not rewritten", async ($, on) => {
  const engine = ddevWorld(on);

  for (const command of [
    '"php" -v',
    "'php' -v",
    'echo "a && php b"',
    "echo 'x; composer install'",
    "echo $(php -v)",
    "echo `php -v`",
    "(php -v)",
    "(cd web && php x)",
  ]) {
    await expectUnchanged($, engine, command);
  }

  await expectRewrite(
    $,
    engine,
    'php -r "echo 1;" && echo "done; php"',
    'ddev exec php -r "echo 1;" && echo "done; php"',
  );
});

test("heredoc bodies are never touched", async ($, on) => {
  const engine = ddevWorld(on);

  await expectUnchanged($, engine, "cat <<EOF\nphp -v\ncomposer install\nEOF");
  await expectUnchanged($, engine, "php <<'PHP'\n<?php echo 1;\nPHP");
  await expectRewrite(
    $,
    engine,
    "composer dump-autoload && cat <<EOF > notes.txt\nphp -v\nEOF",
    "ddev exec composer dump-autoload && cat <<EOF > notes.txt\nphp -v\nEOF",
  );
});

test("a command that does not parse passes unchanged", async ($, on) => {
  const engine = ddevWorld(on);

  for (const command of ['php -r "echo 1', "php x )", "php $(echo"]) {
    await expectUnchanged($, engine, command);
  }
});

test("non-Bash tools never reach the hook", async ($, on) => {
  const engine = ddevWorld(on);

  const answer = await $.tool.call({
    tool: "PowerShell",
    command: "php -v",
  } as unknown as Parameters<Engine["tool"]["call"]>[0]);

  expect(engine.others).toEqual([{ tool: "PowerShell", command: "php -v" }]);
  expect(answer.context ?? []).toEqual([]);
  expect(engine.ran).toEqual([]);
});

test("a throw inside the hook passes the original command", async ($, on) => {
  const engine = world(on, {
    root: freshRoot(),
    isDdev: true,
    isExistsThrowing: true,
  });

  await expectUnchanged($, engine, "php -v");
  expect(engine.ran).toEqual(["php -v"]);
});

test("the shell's folder below the root sets --dir and combines with cd", async ($, on) => {
  const root = freshRoot();
  const engine = world(on, { root, isDdev: true, cwd: `${root}/web/` });

  await expectRewrite(
    $,
    engine,
    "php -v",
    "ddev exec --dir /var/www/html/web php -v",
  );
  await expectRewrite(
    $,
    engine,
    "cd app && composer install",
    "cd app && ddev exec --dir /var/www/html/web/app composer install",
  );
});

test("a folder outside the root passes unchanged", async ($, on) => {
  const engine = world(on, { root: freshRoot(), isDdev: true, cwd: "/tmp" });

  await expectUnchanged($, engine, "php -v");
  expect(engine.ran).toEqual(["php -v"]);
});

test("a sibling folder that only shares the root's prefix passes unchanged", async ($, on) => {
  const root = freshRoot();
  const engine = world(on, { root, isDdev: true, cwd: `${root}-old/web` });

  await expectUnchanged($, engine, "php -v");
});

test("a folder that would need quoting passes unchanged", async ($, on) => {
  const root = freshRoot();
  const engine = world(on, { root, isDdev: true, cwd: `${root}/my dir` });

  await expectUnchanged($, engine, "php -v");
});

test("a folder that cannot be read passes unchanged", async ($, on) => {
  const engine = world(on, { root: freshRoot(), isDdev: true, cwd: "throw" });

  await expectUnchanged($, engine, "php -v");
  expect(engine.ran).toEqual(["php -v"]);
});

test("quoted strings inside a quoted substitution are not rewritten", async ($, on) => {
  const engine = ddevWorld(on);

  for (const command of [
    'echo "$(echo "a; php b")"',
    'gh pr create --body "$(printf "Run: composer install; php artisan migrate")"',
    'echo "${NAME:-"x; php y"}"',
    'echo "`echo "a; php b"`"',
  ]) {
    await expectUnchanged($, engine, command);
  }

  await expectRewrite(
    $,
    engine,
    `php -r "echo '$(date)';" && echo "$(echo "x; php y")"`,
    `ddev exec php -r "echo '$(date)';" && echo "$(echo "x; php y")"`,
  );
});

test("nothing after a # comment is rewritten", async ($, on) => {
  const engine = ddevWorld(on);

  await expectUnchanged($, engine, "echo hi # ; php x");
  await expectUnchanged($, engine, "# php x\ncomposer install");
  await expectRewrite(
    $,
    engine,
    "php -v # check; composer install",
    "ddev exec php -v # check; composer install",
  );
  await expectRewrite(
    $,
    engine,
    "echo a#b; php -v",
    "echo a#b; ddev exec php -v",
  );
});

test("after an || the folder from a cd is unsure, so nothing further is rewritten", async ($, on) => {
  const engine = ddevWorld(on);

  await expectUnchanged($, engine, "cd web && false || php x");
  await expectRewrite(
    $,
    engine,
    "cd web && php x || php y",
    "cd web && ddev exec --dir /var/www/html/web php x || php y",
  );
  await expectRewrite(
    $,
    engine,
    "php x || php y",
    "ddev exec php x || ddev exec php y",
  );
});

test("a denied result gets no note", async ($, on) => {
  const engine = world(on, {
    root: freshRoot(),
    isDdev: true,
    answer: () => ({ deny: "not now" }),
  });

  const answer = await bash($, "php -v");

  expect(engine.ran).toEqual(["ddev exec php -v"]);
  expect(answer.deny).toBe("not now");
  expect(answer.context).toBeUndefined();
});

test("a throw after next was called does not run the command twice", async ($, on) => {
  // The engine checks a stub's answer, so the note step cannot be made to
  // throw from here. Instead the tool beneath runs the rewritten command and
  // then throws: the hook fails after `next` was called, and its `.catch`
  // must not run anything again.
  const engine = world(on, {
    root: freshRoot(),
    isDdev: true,
    answer: () => {
      throw new Error("tool broke after running");
    },
  });

  try {
    await bash($, "php -v");
  } catch {
    // The failure itself may surface; only the number of runs matters here.
  }

  expect(engine.ran).toEqual(["ddev exec php -v"]);
});

test("cd - is not a subfolder, so nothing after it is rewritten", async ($, on) => {
  const engine = ddevWorld(on);

  for (const command of ["cd - && php x", "cd -P && php x", "cd web && cd - && php x"]) {
    await expectUnchanged($, engine, command);
  }
});

test("a cd that may have been skipped makes the folder unsure", async ($, on) => {
  const engine = ddevWorld(on);

  for (const command of [
    "true || cd web && php x",
    "echo | cd web && php x",
  ]) {
    await expectUnchanged($, engine, command);
  }

  await expectRewrite(
    $,
    engine,
    "php -v; cd web && php x",
    "ddev exec php -v; cd web && ddev exec --dir /var/www/html/web php x",
  );
});

test("a lone & separates background commands; redirections do not", async ($, on) => {
  const engine = ddevWorld(on);

  await expectRewrite(
    $,
    engine,
    "php x & php y",
    "ddev exec php x & ddev exec php y",
  );
  await expectRewrite(
    $,
    engine,
    "php x 2>&1 >&2 &>out.log | grep y",
    "ddev exec php x 2>&1 >&2 &>out.log | grep y",
  );
  await expectRewrite(
    $,
    engine,
    "echo a |& php y",
    "echo a |& ddev exec php y",
  );
  await expectUnchanged($, engine, "echo 'a & php b' >/dev/null 2>&1");
});

test("after a background list the folder is back to where that list started", async ($, on) => {
  const engine = ddevWorld(on);

  await expectRewrite(
    $,
    engine,
    "cd web && php x & php y",
    "cd web && ddev exec --dir /var/www/html/web php x & ddev exec php y",
  );
  await expectRewrite(
    $,
    engine,
    "cd web && false || php x & php y",
    "cd web && false || php x & ddev exec php y",
  );
  await expectRewrite(
    $,
    engine,
    "cd web && php x; cd app && php y & php z",
    "cd web && ddev exec --dir /var/www/html/web php x; cd app && ddev exec --dir /var/www/html/web/app php y & ddev exec --dir /var/www/html/web php z",
  );
});
