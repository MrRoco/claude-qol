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

    return { result: { ok: true } };
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
