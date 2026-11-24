import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Badge } from "../types";

type Engine = EngineInterface;

const SEPARATOR = " · ";
// Read limits: `$.fs.read` rejects past 4 MiB anyway; checking first keeps a
// huge lock file from being copied in at all.
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_WORKFLOW_FILES = 50;
const WORKFLOW_DIR = "workflows";
// Where MODX lives under DDEV when its config names no docroot.
const DEFAULT_DOCROOT = "webroot";
// A value from `.ddev/config.yaml` is used only when it looks like one: a
// path or a word, never a sentence, a quote left open or a parent folder.
const SAFE_VALUE = /^[A-Za-z0-9._/-]{1,64}$/;

const TEXT_HEADER = "project-badge: what this project is.";
const TEXT_DDEV_RUN =
  "Run PHP, Composer, artisan and vendor/bin tools with ddev exec, not on the host.";
const TEXT_LARAVEL_RULES =
  "follow Laravel conventions (artisan make commands, form requests, Eloquent, config through config/ and .env, never hardcoded).";
const TEXT_MODX_RULES =
  "no MVC. Work with snippets, plugins, chunks and templates; data through xPDO ($modx->getObject, getCollection); Fenom syntax {$var}. Check core/components/<extra>/ for existing patterns before writing new code.";
const TEXT_N8N_RULES =
  "Follow n8n node conventions and keep credentials out of the JSON.";

const badgeAtom = atom(
  { plugin: "project-badge", key: "badge" } as const,
  null as Badge,
);

type Ddev = { type?: string; phpVersion?: string; docroot?: string };

type Framework =
  | { kind: "laravel"; version?: string }
  | { kind: "modx"; version?: string }
  | { kind: "n8n"; count: number };

type Detection = { ddev: Ddev | null; framework: Framework | null };

// Module variables, never in `$.state`: the block for Claude and whether it
// went out in this session.
let contextText: string | null = null;
let isContextSent = false;
// Counts detections; only the latest one may write its result.
let detectionId = 0;
// The detection under way, so the first prompt waits for its answer.
let pendingDetection: Promise<void> | null = null;

/** Every file access goes through these: a failure leaves that part out. */
const existsSafe = async ($: Engine, path: string): Promise<boolean> => {
  try {
    return await $.fs.exists(path);
  } catch {
    return false;
  }
};

const isDirectory = async ($: Engine, path: string): Promise<boolean> => {
  try {
    return (await $.fs.stat(path)).kind === "dir";
  } catch {
    return false;
  }
};

const readSafe = async ($: Engine, path: string): Promise<string | null> => {
  try {
    return await $.fs.read(path);
  } catch {
    return null;
  }
};

const parseJson = (text: string | null): unknown => {
  if (text === null) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The few keys of `.ddev/config.yaml` the badge uses, one line regex each:
 * top-level keys only (no indent), an optional quote pair, a trailing
 * comment dropped. A line that does not fit is left out.
 */
const parseDdev = (text: string): Ddev => {
  const keys: Record<string, keyof Ddev> = {
    type: "type",
    php_version: "phpVersion",
    docroot: "docroot",
  };
  const ddev: Ddev = {};

  for (const line of text.split(/\r?\n/)) {
    const match = /^(type|php_version|docroot):[ \t]*(.*)$/.exec(line);

    if (match === null) {
      continue;
    }

    const field = keys[match[1] ?? ""];
    let value = (match[2] ?? "").replace(/[ \t]+#.*$/, "").trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);

    if (quoted !== null) {
      value = quoted[2] ?? "";
    }

    // No parent folders and no absolute paths: nothing outside the root.
    const isSafe =
      SAFE_VALUE.test(value) &&
      !value.startsWith("/") &&
      !value.split("/").includes("..");

    if (field !== undefined && isSafe && ddev[field] === undefined) {
      ddev[field] = value;
    }
  }

  return ddev;
};

const detectDdev = async ($: Engine, root: string): Promise<Ddev | null> => {
  const path = `${root}/.ddev/config.yaml`;

  if (!(await existsSafe($, path))) {
    return null;
  }

  const text = await readSafe($, path);

  return text === null ? {} : parseDdev(text);
};

/** The major of `laravel/framework` in `composer.lock` (`v11.9.2` → `11`). */
const laravelVersion = async (
  $: Engine,
  root: string,
): Promise<string | undefined> => {
  const path = `${root}/composer.lock`;

  try {
    const stat = await $.fs.stat(path);

    if (stat.kind !== "file" || stat.size >= MAX_LOCK_BYTES) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const lock = parseJson(await readSafe($, path));
  const packages = isObject(lock) ? lock.packages : undefined;

  if (!Array.isArray(packages)) {
    return undefined;
  }

  const framework: unknown = packages.find(
    (entry: unknown) => isObject(entry) && entry.name === "laravel/framework",
  );
  const version = isObject(framework) ? framework.version : undefined;
  const major = typeof version === "string" ? /^v?(\d+)\./.exec(version) : null;

  return major?.[1];
};

/** `version` and `major_version` of MODX's `version.inc.php` (→ `3.0`). */
const modxVersion = async (
  $: Engine,
  path: string,
): Promise<string | undefined> => {
  const text = await readSafe($, path);

  if (text === null) {
    return undefined;
  }

  const value = (name: string): string | undefined =>
    new RegExp(
      String.raw`\$v\s*\[\s*['"]${name}['"]\s*\]\s*=\s*['"]?(\d+)`,
    ).exec(text)?.[1];
  const major = value("version");
  const minor = value("major_version");

  return major !== undefined && minor !== undefined
    ? `${major}.${minor}`
    : undefined;
};

/**
 * MODX by existence only: `config.inc.php` holds the database credentials,
 * so it is never opened. Returns the `core` folder found, or null.
 */
const findModxCore = async (
  $: Engine,
  root: string,
  docroot: string,
): Promise<string | null> => {
  const cores = [`${root}/core`];

  if (docroot !== "" && docroot !== ".") {
    cores.push(`${root}/${docroot.replace(/\/+$/, "")}/core`);
  }

  for (const core of cores) {
    const isFound =
      (await existsSafe($, `${core}/config/config.inc.php`)) ||
      (core !== cores[0] && (await existsSafe($, `${core}/config.inc.php`))) ||
      (await isDirectory($, `${core}/components`));

    if (isFound) {
      return core;
    }
  }

  return null;
};

/** Names never opened, even when they end in `.json`. */
const isForbidden = (name: string): boolean =>
  name.startsWith(".env") || name === "auth.json";

/** JSON files of a folder worth opening, under the size limit. */
const jsonFiles = async ($: Engine, folder: string): Promise<string[]> => {
  try {
    const entries = await $.fs.list(folder);

    return entries
      .filter(
        (entry) =>
          entry.kind === "file" &&
          entry.name.toLowerCase().endsWith(".json") &&
          !isForbidden(entry.name) &&
          entry.size < MAX_WORKFLOW_BYTES,
      )
      .map((entry) => `${folder}/${entry.name}`);
  } catch {
    return [];
  }
};

const isWorkflow = (value: unknown): boolean =>
  isObject(value) && Array.isArray(value.nodes) && isObject(value.connections);

/** n8n workflow files in the root and `workflows/`, at most 50 opened. */
const countWorkflows = async ($: Engine, root: string): Promise<number> => {
  const files = [
    ...(await jsonFiles($, root)),
    ...(await jsonFiles($, `${root}/${WORKFLOW_DIR}`)),
  ].slice(0, MAX_WORKFLOW_FILES);
  let count = 0;

  for (const file of files) {
    if (isWorkflow(parseJson(await readSafe($, file)))) {
      count += 1;
    }
  }

  return count;
};

/** The framework layer: first match wins. */
const detectFramework = async (
  $: Engine,
  root: string,
  ddev: Ddev | null,
): Promise<Framework | null> => {
  if (
    (await existsSafe($, `${root}/artisan`)) &&
    (await isDirectory($, `${root}/app`))
  ) {
    return { kind: "laravel", version: await laravelVersion($, root) };
  }

  const core = await findModxCore($, root, ddev?.docroot ?? DEFAULT_DOCROOT);

  if (core !== null) {
    return {
      kind: "modx",
      version: await modxVersion($, `${core}/docs/version.inc.php`),
    };
  }

  const count = await countWorkflows($, root);

  return count > 0 ? { kind: "n8n", count } : null;
};

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const withVersion = (name: string, version: string | undefined): string =>
  version === undefined ? name : `${name} ${version}`;

const badgeOf = ({ ddev, framework }: Detection): Badge => {
  const parts: string[] = [];

  if (ddev !== null) {
    parts.push("DDEV");
  }

  if (framework?.kind === "laravel") {
    parts.push(withVersion("Laravel", framework.version));
  } else if (framework?.kind === "modx") {
    parts.push(withVersion("MODX", framework.version));
  } else if (framework?.kind === "n8n") {
    parts.push(`n8n${SEPARATOR}${plural(framework.count, "workflow")}`);
  } else if (ddev?.type !== undefined) {
    parts.push(ddev.type);
  }

  if (ddev?.phpVersion !== undefined) {
    parts.push(`PHP ${ddev.phpVersion}`);
  }

  return parts.length === 0 ? null : parts.join(SEPARATOR);
};

const contextOf = ({ ddev, framework }: Detection): string | null => {
  const blocks: string[] = [];

  if (ddev !== null) {
    const details = [
      ddev.type,
      ddev.phpVersion === undefined ? undefined : `PHP ${ddev.phpVersion}`,
      ddev.docroot === undefined ? undefined : `docroot ${ddev.docroot}`,
    ].filter((part): part is string => part !== undefined);
    const about = details.length === 0 ? "" : ` (${details.join(", ")})`;

    blocks.push(`This is a DDEV project${about}. ${TEXT_DDEV_RUN}`);
  }

  if (framework?.kind === "laravel") {
    blocks.push(
      `${withVersion("Laravel", framework.version)}: ${TEXT_LARAVEL_RULES}`,
    );
  } else if (framework?.kind === "modx") {
    blocks.push(
      `${withVersion("MODX", framework.version)}: ${TEXT_MODX_RULES}`,
    );
  } else if (framework?.kind === "n8n") {
    blocks.push(
      `This folder holds ${plural(framework.count, "n8n workflow file")}. ${TEXT_N8N_RULES}`,
    );
  }

  return blocks.length === 0 ? null : [TEXT_HEADER, ...blocks].join("\n\n");
};

const detect = async ($: Engine): Promise<Detection> => {
  const root = (await $.session.root()).replace(/[\\/]+$/, "");
  const ddev = await detectDdev($, root);

  return { ddev, framework: await detectFramework($, root, ddev) };
};

/**
 * Detects and stores the result, unless a newer detection started meanwhile.
 * Never touches `isContextSent`: a reload must not send the block twice.
 */
const refresh = async ($: Engine): Promise<void> => {
  detectionId += 1;
  const id = detectionId;
  let detection: Detection = { ddev: null, framework: null };

  try {
    detection = await detect($);
  } catch {
    // No root, or something else beneath failed: no badge, no context.
  }

  if (id !== detectionId) {
    return;
  }

  contextText = contextOf(detection);
  const badge = badgeOf(detection);

  try {
    await update($, badgeAtom, () => badge);
    $.ui.invalidate("ui.render");
  } catch {
    // The badge stays as it was; the context block is set above regardless.
  }
};

export const register: Register = (on) => {
  // At the start and at every reload: files may have changed. Detection runs
  // unawaited so the session does not wait on the file system.
  on("session.start", ($, e, next) => {
    const detection = refresh($);
    pendingDetection = detection;
    void detection.finally(() => {
      if (pendingDetection === detection) {
        pendingDetection = null;
      }
    });

    return next(e);
  });

  // `/clear` starts a new conversation: the block goes out again.
  on("session.end", ($, e, next) => {
    if (e.reason === "clear") {
      isContextSent = false;
    }

    return next(e);
  });

  // The only hook that changes an event: it adds the block to the first
  // prompt as context; the text is never touched.
  on("prompt.submit", async ($, e, next) => {
    if (e.isMeta === true || e.command !== undefined) {
      return next(e);
    }

    if (pendingDetection !== null) {
      await pendingDetection;
    }

    // Checked and set with no await between, so two prompts cannot both send.
    const text = contextText;

    if (isContextSent || text === null) {
      return next(e);
    }

    isContextSent = true;

    return next({ ...e, context: [...(e.context ?? []), text] });
  }).catch(($, e, next) => next(e));

  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    const badge = await read($, badgeAtom);

    if (badge === null) {
      return next(e);
    }

    // Another mod's tail is kept, the badge after it.
    const tail =
      e.props.tail === undefined || e.props.tail === ""
        ? badge
        : `${e.props.tail}${SEPARATOR}${badge}`;

    return next({ ...e, props: { ...e.props, tail } });
  });
};
