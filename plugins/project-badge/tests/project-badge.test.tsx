import { expect, mock, test } from "claude-code/testing";
import type { Engine, MockClock } from "claude-code/testing";
import type { On } from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;
const ROOT = "/work/project";
const MIB = 1024 * 1024;

const HEADER = "project-badge: what this project is.";
const DDEV_RUN =
  "Run PHP, Composer, artisan and vendor/bin tools with ddev exec, not on the host.";
const MODX_RULES =
  "no MVC. Work with snippets, plugins, chunks and templates; data through xPDO ($modx->getObject, getCollection); Fenom syntax {$var}. Check core/components/<extra>/ for existing patterns before writing new code.";
const LARAVEL_RULES =
  "follow Laravel conventions (artisan make commands, form requests, Eloquent, config through config/ and .env, never hardcoded).";
const N8N_RULES =
  "Follow n8n node conventions and keep credentials out of the JSON.";

const HINT = {
  plugin: "project-badge",
  component: "PromptHint",
  props: { isDraft: false, isWorking: false, hint: "? for shortcuts" },
} as const;

const MODX_VERSION = `<?php
$v= array();
$v['version']= '3';
$v['major_version']= '0';
$v['minor_version']= '4';
$v['patch_level']= 'pl';
return $v;
`;

const WORKFLOW = JSON.stringify({ name: "Flow", nodes: [], connections: {} });

type Tree = {
  // Path under the root → text, or a size alone for a file never read here.
  files?: Record<string, string | { size: number }>;
  dirs?: string[];
  // Paths whose read fails beneath the mod.
  unreadable?: string[];
  // Folders whose listing fails beneath the mod.
  unlistable?: string[];
  // Path under the root → where it really lands: a symbolic link.
  links?: Record<string, string>;
  // Paths whose `exists` check waits until the test calls `release`.
  held?: string[];
  // No clock beneath the mod: every `$.clock` call fails.
  noClock?: boolean;
};

type World = {
  reads: string[];
  checked: string[];
  entered: { text: string; context: readonly string[] | undefined }[];
  tails: (string | undefined)[];
  clock: MockClock | null;
  // Lets the held `exists` checks answer.
  release: () => void;
};

// The test runtime has a timer; the hooks' typings (es2023 only) name none.
const { setTimeout: later } = globalThis as unknown as {
  setTimeout: (run: () => void, ms: number) => unknown;
};

/** Lets the unawaited detection started at `session.start` finish. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) {
    await new Promise<void>((resolve) => later(resolve, 0));
  }
};

const ENOENT = { deny: "ENOENT" } as const;

/** An in-memory project beneath the mod, recording every path it touched. */
const world = (on: On, tree: Tree): World => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result: World = {
    reads: [],
    checked: [],
    entered: [],
    tails: [],
    clock: tree.noClock === true ? null : mock.clock(on),
    release: () => release(),
  };
  const files = new Map(
    Object.entries(tree.files ?? {}).map(([path, value]) => [
      `${ROOT}/${path}`,
      value,
    ]),
  );
  const dirs = new Set([ROOT, ...(tree.dirs ?? []).map((d) => `${ROOT}/${d}`)]);
  // Every parent folder of a file or folder exists too.
  for (const path of [...files.keys(), ...dirs]) {
    const parts = path.split("/");
    for (let i = parts.length - 1; i > 1; i -= 1) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  const unreadable = new Set(
    (tree.unreadable ?? []).map((p) => `${ROOT}/${p}`),
  );
  const unlistable = new Set(
    (tree.unlistable ?? []).map((p) => (p === "" ? ROOT : `${ROOT}/${p}`)),
  );
  const sizeOf = (value: string | { size: number }): number =>
    typeof value === "string" ? value.length : value.size;
  const links = Object.entries(tree.links ?? {}).map(
    ([path, target]) => [`${ROOT}/${path}`, target] as const,
  );
  const held = new Set((tree.held ?? []).map((p) => `${ROOT}/${p}`));
  // Where a path really lands: a link on the way swaps its prefix.
  const realPathOf = (path: string): string => {
    for (const [link, target] of links) {
      if (path === link || path.startsWith(`${link}/`)) {
        return `${target}${path.slice(link.length)}`;
      }
    }

    return path;
  };

  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.root", () => ({ value: ROOT }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("fs.exists", async (_, e) => {
    result.checked.push(e.path);

    if (held.has(e.path)) {
      await gate;
    }

    return { value: files.has(e.path) || dirs.has(e.path) };
  });
  on("fs.stat", (_, e) => {
    result.checked.push(e.path);
    const file = files.get(e.path);
    const isLink = links.some(([link]) => link === e.path);
    const real = e.resolve ? { realPath: realPathOf(e.path) } : {};

    if (file !== undefined) {
      return {
        value: {
          kind: "file" as const,
          size: sizeOf(file),
          mtimeMs: 0,
          isLink,
          ...real,
        },
      };
    }

    return dirs.has(e.path)
      ? {
          value: {
            kind: "dir" as const,
            size: 0,
            mtimeMs: 0,
            isLink,
            ...real,
          },
        }
      : ENOENT;
  });
  on("fs.list", (_, e) => {
    if (unlistable.has(e.path) || !dirs.has(e.path)) {
      return ENOENT;
    }

    const prefix = `${e.path}/`;
    const isChild = (path: string): boolean =>
      path.startsWith(prefix) && !path.slice(prefix.length).includes("/");

    return {
      value: [
        ...[...files.entries()]
          .filter(([path]) => isChild(path))
          .map(([path, value]) => ({
            name: path.slice(prefix.length),
            kind: "file" as const,
            size: sizeOf(value),
            mtimeMs: 0,
            isLink: false,
          })),
        ...[...dirs].filter(isChild).map((path) => ({
          name: path.slice(prefix.length),
          kind: "dir" as const,
          size: 0,
          mtimeMs: 0,
          isLink: false,
        })),
      ],
    };
  });
  on("fs.read", (_, e) => {
    result.reads.push(e.path);
    const file = files.get(e.path);

    if (unreadable.has(e.path) || typeof file !== "string") {
      return unreadable.has(e.path) ? { deny: "EACCES" } : ENOENT;
    }

    return { value: file };
  });
  on("prompt.submit", (_, e) => {
    result.entered.push({ text: e.text, context: e.context });

    return { text: e.text, context: e.context };
  });
  on("ui.render", { component: "PromptHint" }, (_, e, next) => {
    result.tails.push(e.props.tail);

    return next(e);
  });

  return result;
};

const start = async ($: Engine): Promise<void> => {
  await $.session.start({
    cwd: ROOT,
    surface: "terminal",
    isInteractive: true,
  });
  await settle();
};

const submit = ($: Engine, text: string, extra: Record<string, unknown> = {}) =>
  $.prompt.submit({
    text,
    wait: false,
    origin: { kind: "composer" },
    ...extra,
  } as never);

/** The tail the hint line gets on each surface; one value when they agree. */
const tailOf = async (
  $: Engine,
  engine: World,
): Promise<string | undefined> => {
  const seen: (string | undefined)[] = [];

  for (const surface of SURFACES) {
    engine.tails.length = 0;
    const ui = await $.ui.mount({ ...HINT, surface });
    seen.push(engine.tails[engine.tails.length - 1]);
    await ui.unmount();
  }

  expect(seen[0]).toBe(seen[1]);

  return seen[0];
};

/** The context the first prompt carried. */
const firstContext = async ($: Engine, engine: World) => {
  await submit($, "hello");

  return engine.entered[engine.entered.length - 1]?.context;
};

const isSecret = (path: string): boolean =>
  /config\.inc\.php$|\/\.env[^/]*$|\/auth\.json$|\/credentials[^/]*$|service-account[^/]*$/i.test(
    path,
  );

const MODX_ROOT: Tree = {
  files: {
    ".ddev/config.yaml":
      'name: shop\ntype: php\ndocroot: ""\nphp_version: "8.2"\n',
    "core/config/config.inc.php": "<?php $database_password = 'secret';",
    "core/docs/version.inc.php": MODX_VERSION,
    ".env": "DB_PASSWORD=secret",
  },
};

const MODX_CONTEXT = [
  HEADER,
  `This is a DDEV project (php, PHP 8.2, docroot the project root). ${DDEV_RUN}`,
  `MODX 3.0: ${MODX_RULES}`,
].join("\n\n");

test("DDEV + MODX in the root: badge, context, credentials never read", async ($, on) => {
  const engine = world(on, MODX_ROOT);
  await start($);

  expect(await tailOf($, engine)).toBe("DDEV · MODX 3.0 · PHP 8.2");
  expect(await firstContext($, engine)).toEqual([MODX_CONTEXT]);
  expect(engine.checked).toContain(`${ROOT}/core/config/config.inc.php`);
  expect(engine.reads.filter(isSecret)).toEqual([]);
});

test("DDEV + MODX under webroot/ (config.inc.php in core/) with the docroot named", async ($, on) => {
  const engine = world(on, {
    files: {
      ".ddev/config.yaml":
        "type: php # the project type\ndocroot: webroot\nphp_version: '8.2'\n",
      "webroot/core/config.inc.php": "<?php $database_password = 'secret';",
      "webroot/core/docs/version.inc.php": MODX_VERSION,
    },
  });
  await start($);

  expect(await tailOf($, engine)).toBe("DDEV · MODX 3.0 · PHP 8.2");
  expect(await firstContext($, engine)).toEqual([
    [
      HEADER,
      `This is a DDEV project (php, PHP 8.2, docroot webroot). ${DDEV_RUN}`,
      `MODX 3.0: ${MODX_RULES}`,
    ].join("\n\n"),
  ]);
  expect(engine.checked).toContain(`${ROOT}/webroot/core/config.inc.php`);
  expect(engine.reads.filter(isSecret)).toEqual([]);
});

test("MODX under webroot/ by its components folder, no docroot in the config", async ($, on) => {
  const engine = world(on, {
    files: { ".ddev/config.yaml": 'type: php\nphp_version: "8.1"\n' },
    dirs: ["webroot/core/components"],
  });
  await start($);

  // No version file: MODX without a version.
  expect(await tailOf($, engine)).toBe("DDEV · MODX · PHP 8.1");
});

test("DDEV + Laravel: major version from composer.lock", async ($, on) => {
  const engine = world(on, {
    files: {
      ".ddev/config.yaml":
        'type: laravel\nphp_version: "8.3"\ndocroot: public\n',
      artisan: "#!/usr/bin/env php",
      "composer.lock": JSON.stringify({
        packages: [
          { name: "guzzlehttp/guzzle", version: "7.8.1" },
          { name: "laravel/framework", version: "v11.9.2" },
        ],
      }),
      ".env": "APP_KEY=secret",
      "auth.json": "{}",
    },
    dirs: ["app"],
  });
  await start($);

  expect(await tailOf($, engine)).toBe("DDEV · Laravel 11 · PHP 8.3");
  expect(await firstContext($, engine)).toEqual([
    [
      HEADER,
      `This is a DDEV project (laravel, PHP 8.3, docroot public). ${DDEV_RUN}`,
      `Laravel 11: ${LARAVEL_RULES}`,
    ].join("\n\n"),
  ]);
  expect(engine.reads.filter(isSecret)).toEqual([]);
});

test("DDEV only: DDEV's own type and the DDEV rules alone", async ($, on) => {
  const engine = world(on, {
    files: {
      ".ddev/config.yaml": 'name: blog\ntype: wordpress\nphp_version: "8.1"\n',
    },
  });
  await start($);

  expect(await tailOf($, engine)).toBe("DDEV · wordpress · PHP 8.1");
  expect(await firstContext($, engine)).toEqual([
    [HEADER, `This is a DDEV project (wordpress, PHP 8.1). ${DDEV_RUN}`].join(
      "\n\n",
    ),
  ]);
});

test("n8n: workflow files in the root and workflows/ are counted", async ($, on) => {
  const engine = world(on, {
    files: {
      "invoice.json": WORKFLOW,
      "sync.json": WORKFLOW,
      "package.json": JSON.stringify({ name: "x", nodes: "no" }),
      "workflows/a.json": WORKFLOW,
      "workflows/b.json": WORKFLOW,
      "workflows/broken.json": "{ nodes: [",
      "workflows/huge.json": { size: 2 * MIB },
      ".env.json": WORKFLOW,
      "auth.json": WORKFLOW,
      "AUTH.JSON": WORKFLOW,
      ".ENV.prod.json": WORKFLOW,
      "credentials.json": WORKFLOW,
      "Credentials-prod.json": WORKFLOW,
      "workflows/my-Service-Account-key.json": WORKFLOW,
      "workflows/gcp-service-account.json": WORKFLOW,
      ".env": "TOKEN=secret",
    },
  });
  await start($);

  expect(await tailOf($, engine)).toBe("n8n · 4 workflows");
  expect(await firstContext($, engine)).toEqual([
    [HEADER, `This folder holds 4 n8n workflow files. ${N8N_RULES}`].join(
      "\n\n",
    ),
  ]);
  expect(engine.reads.filter(isSecret)).toEqual([]);
  expect(engine.reads).not.toContain(`${ROOT}/workflows/huge.json`);
});

test("n8n: one workflow is singular; at most 50 files are opened", async ($, on) => {
  const files: Record<string, string> = { "flow.json": WORKFLOW };
  for (let i = 0; i < 60; i += 1) {
    files[`workflows/data-${String(i).padStart(2, "0")}.json`] = "[]";
  }
  const engine = world(on, { files });
  await start($);

  expect(await tailOf($, engine)).toBe("n8n · 1 workflow");
  expect(engine.reads.length).toBe(50);
});

test("an empty folder: no badge, no context", async ($, on) => {
  const engine = world(on, {});
  await start($);

  expect(await tailOf($, engine)).toBeUndefined();
  expect(await firstContext($, engine)).toBeUndefined();
  expect(engine.entered[0]?.text).toBe("hello");
});

test("the block goes with the first prompt only, text unchanged; again after /clear", async ($, on) => {
  const engine = world(on, MODX_ROOT);
  await start($);

  await submit($, "first", { context: ["from another mod"] });
  await submit($, "second");
  expect(engine.entered).toEqual([
    { text: "first", context: ["from another mod", MODX_CONTEXT] },
    { text: "second", context: undefined },
  ]);

  // A reload re-detects but does not send the block again.
  await start($);
  await submit($, "third");
  expect(engine.entered[2]).toEqual({ text: "third", context: undefined });

  await $.session.end({
    reason: "clear",
    sessionId: "s1",
    resume: {} as never,
  });
  await submit($, "after clear");
  await submit($, "and again");
  expect(engine.entered.slice(3)).toEqual([
    { text: "after clear", context: [MODX_CONTEXT] },
    { text: "and again", context: undefined },
  ]);
});

test("meta prompts and slash commands do not use up the block", async ($, on) => {
  const engine = world(on, MODX_ROOT);
  await start($);

  await submit($, "meta", { isMeta: true });
  await submit($, "/review x", { command: { name: "review", args: "x" } });
  await submit($, "typed");

  expect(engine.entered).toEqual([
    { text: "meta", context: undefined },
    { text: "/review x", context: undefined },
    { text: "typed", context: [MODX_CONTEXT] },
  ]);
});

test("a prompt sent before detection finished still gets the block", async ($, on) => {
  const engine = world(on, MODX_ROOT);
  void $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });

  await submit($, "quick");
  expect(engine.entered[0]?.context).toEqual([MODX_CONTEXT]);
});

test("bad YAML lines are left out, the rest is kept", async ($, on) => {
  const engine = world(on, {
    files: {
      ".ddev/config.yaml":
        'type: [php, node]\nphp_version: "8.2\ndocroot: ../../etc\n  type: nested\n',
    },
  });
  await start($);

  expect(await tailOf($, engine)).toBe("DDEV");
  expect(await firstContext($, engine)).toEqual([
    [HEADER, `This is a DDEV project. ${DDEV_RUN}`].join("\n\n"),
  ]);
  // The docroot pointing outside the root was never followed.
  expect(engine.checked.filter((p) => p.includes(".."))).toEqual([]);
});

test("bad JSON in composer.lock: Laravel without a version", async ($, on) => {
  const engine = world(on, {
    files: { artisan: "", "composer.lock": "{ not json" },
    dirs: ["app"],
  });
  await start($);

  expect(await tailOf($, engine)).toBe("Laravel");
});

test("a huge composer.lock is not read", async ($, on) => {
  const engine = world(on, {
    files: {
      ".ddev/config.yaml": "type: laravel\n",
      artisan: "",
      "composer.lock": { size: 5 * MIB },
    },
    dirs: ["app"],
  });
  await start($);

  expect(await tailOf($, engine)).toBe("DDEV · Laravel");
  expect(engine.reads).not.toContain(`${ROOT}/composer.lock`);
});

test("failed reads leave that part out and never throw", async ($, on) => {
  const engine = world(on, {
    files: {
      ".ddev/config.yaml": "type: php\n",
      "core/config/config.inc.php": "<?php",
      "core/docs/version.inc.php": MODX_VERSION,
    },
    unreadable: [".ddev/config.yaml", "core/docs/version.inc.php"],
  });
  await start($);

  expect(await tailOf($, engine)).toBe("DDEV · MODX");
  expect(engine.reads.filter(isSecret)).toEqual([]);
});

test("a failed listing means no n8n, and no throw", async ($, on) => {
  // The root cannot be listed; `workflows/` can, and holds no workflow.
  const engine = world(on, {
    files: { "flow.json": WORKFLOW, "workflows/notes.json": "[]" },
    unlistable: [""],
  });
  await start($);

  expect(await tailOf($, engine)).toBeUndefined();
});

test("other hooks pass events on unchanged", async ($, on) => {
  world(on, MODX_ROOT);

  expect(
    await $.session.start({
      cwd: ROOT,
      surface: "terminal",
      isInteractive: true,
    }),
  ).toEqual({ cwd: ROOT });
  expect(
    await $.session.end({
      reason: "other",
      sessionId: "s2",
      resume: {} as never,
    }),
  ).toEqual({ sessionId: "s2" });
});

test("the first prompt waits for detection at most 1 s, then goes without the block", async ($, on) => {
  const engine = world(on, { ...MODX_ROOT, held: [".ddev/config.yaml"] });
  await start($);

  const early = submit($, "early");
  await engine.clock?.settle();
  await engine.clock?.advance(999);
  expect(engine.entered).toEqual([]);

  await engine.clock?.advance(1);
  await early;
  expect(engine.entered).toEqual([{ text: "early", context: undefined }]);

  // Detection finishes later: the next prompt takes the block.
  engine.release();
  await settle();
  await submit($, "later");
  expect(engine.entered[1]).toEqual({ text: "later", context: [MODX_CONTEXT] });
});

test(
  "a prompt cut while waiting does not use up the block",
  {
    plugins: [
      {
        name: "impatient",
        tier: "prepend",
        register(on) {
          let calls = 0;
          // The first prompt is answered above without waiting for the hooks
          // beneath, which cuts their dispatch.
          on("prompt.submit", (_, e, next) => {
            calls += 1;

            if (calls === 1) {
              void next(e).catch(() => undefined);

              return { text: e.text, context: e.context };
            }

            return next(e);
          });
        },
      },
    ],
  },
  async ($, on) => {
    const engine = world(on, { ...MODX_ROOT, held: [".ddev/config.yaml"] });
    await start($);

    await submit($, "cut");
    await engine.clock?.settle();
    // The detection finishes after the cut prompt's dispatch went on.
    engine.release();
    await settle();

    await submit($, "next");
    expect(
      engine.entered.filter((entry) => entry.context !== undefined),
    ).toEqual([{ text: "next", context: [MODX_CONTEXT] }]);
  },
);

test('a docroot of "" is the project root: no webroot/ lookup', async ($, on) => {
  const engine = world(on, {
    files: { ".ddev/config.yaml": 'type: php\ndocroot: ""\n' },
    dirs: ["webroot/core/components"],
  });
  await start($);

  expect(await tailOf($, engine)).toBe("DDEV · php");
  expect(await firstContext($, engine)).toEqual([
    [
      HEADER,
      `This is a DDEV project (php, docroot the project root). ${DDEV_RUN}`,
    ].join("\n\n"),
  ]);
  expect(engine.checked.filter((p) => p.includes("webroot"))).toEqual([]);
});

test("linked files whose real path is outside the root are not read", async ($, on) => {
  const engine = world(on, {
    files: {
      ".ddev/config.yaml": 'type: laravel\nphp_version: "8.3"\n',
      artisan: "",
      "composer.lock": JSON.stringify({
        packages: [{ name: "laravel/framework", version: "v11.0.0" }],
      }),
    },
    dirs: ["app"],
    links: {
      ".ddev/config.yaml": "/elsewhere/ddev.yaml",
      "composer.lock": "/elsewhere/composer.lock",
    },
  });
  await start($);

  expect(await tailOf($, engine)).toBe("DDEV · Laravel");
  expect(engine.reads).toEqual([]);
});

test("a core folder linked outside the root is not trusted", async ($, on) => {
  const engine = world(on, {
    files: {
      "core/config/config.inc.php": "<?php",
      "core/docs/version.inc.php": MODX_VERSION,
    },
    links: { core: "/elsewhere/core" },
  });
  await start($);

  expect(await tailOf($, engine)).toBeUndefined();
  expect(engine.reads).toEqual([]);
});

test("a MODX version file linked outside the root is not read", async ($, on) => {
  const engine = world(on, {
    files: {
      "core/config/config.inc.php": "<?php",
      "core/docs/version.inc.php": MODX_VERSION,
    },
    links: { "core/docs/version.inc.php": "/elsewhere/version.inc.php" },
  });
  await start($);

  expect(await tailOf($, engine)).toBe("MODX");
  expect(engine.reads).toEqual([]);
});

test("a workflows/ folder linked outside the root is not scanned", async ($, on) => {
  const engine = world(on, {
    files: { "workflows/a.json": WORKFLOW, "workflows/b.json": WORKFLOW },
    links: { workflows: "/elsewhere/workflows" },
  });
  await start($);

  expect(await tailOf($, engine)).toBeUndefined();
  expect(engine.reads).toEqual([]);
});

test(
  "the badge goes after another hook's tail",
  {
    plugins: [
      {
        name: "other-tail",
        tier: "prepend",
        register(on) {
          on("ui.render", { component: "PromptHint" }, (_, e, next) =>
            next({ ...e, props: { ...e.props, tail: "main" } }),
          );
        },
      },
    ],
  },
  async ($, on) => {
    const engine = world(on, MODX_ROOT);
    await start($);

    expect(await tailOf($, engine)).toBe("main · DDEV · MODX 3.0 · PHP 8.2");
  },
);

test("when the prompt hook throws, the prompt goes on unchanged", async ($, on) => {
  const engine = world(on, {
    ...MODX_ROOT,
    held: [".ddev/config.yaml"],
    noClock: true,
  });
  await start($);

  // With detection running, the wait calls `$.clock`, which fails here: the
  // hook throws and its fallback passes the prompt on as it came.
  await submit($, "hello", { context: ["from another mod"] });
  expect(engine.entered).toEqual([
    { text: "hello", context: ["from another mod"] },
  ]);

  // The block was not used up.
  engine.release();
  await settle();
  await submit($, "again");
  expect(engine.entered[1]).toEqual({ text: "again", context: [MODX_CONTEXT] });
});
