import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { ModLock, ModRow, ModScope } from "../types";

type Engine = EngineInterface;

const SELF_NAME = "mod-switch";
const PANE_ID = "mod-switch";
const PANE_TITLE = "Mods";
const COMMAND = "mods";
const COMMAND_DESCRIPTION =
  "Open the Mods pane to turn installed mods on or off";

// Theme keys only, never fixed colours.
const SUCCESS = "success";
const DANGER = "error";

// The only three argv shapes this mod ever runs (see the phase contract).
const CLI = "claude";
const LIST_TIMEOUT_MS = 15_000;
const SWITCH_TIMEOUT_MS = 30_000;

// What may reach a process call: a plain `name@marketplace` and a scope the
// CLI writes to. Anything else is refused before a process starts.
const ID_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const SWITCH_SCOPES: readonly string[] = ["user", "project", "local"];
const LIST_SCOPES: readonly string[] = ["user", "project", "local", "session"];

const SETS_KEY = "sets";
const SET_NAME_PATTERN = /^[A-Za-z0-9 -]{1,30}$/;
const MAX_SETS = 50;
const MAX_SET_IDS = 500;

const MAX_DESCRIPTION = 200;
const MAX_REASON = 200;

const LOCK_TEXT: Record<ModLock, string> = {
  managed: "managed",
  session: "session only",
  self: "this mod",
};

const modsAtom = atom({ plugin: "mod-switch", key: "mods" } as const, []);
const isLoadingAtom = atom(
  { plugin: "mod-switch", key: "isLoading" } as const,
  false,
);
const needsReloadAtom = atom(
  { plugin: "mod-switch", key: "needsReload" } as const,
  false,
);
const busyIdAtom = atom({ plugin: "mod-switch", key: "busyId" } as const, null);

type SavedSet = { name: string; on: string[] };

/** What `plugin.register` showed about one plugin this session. */
export type Seen = {
  hasModule: boolean;
  isManaged: boolean;
  version: string | null;
};

// Module variables: pane-only details that need not outlive a reload.
// `plugin.register` fires again for every plugin at a reload, so `seen` fills
// up again by itself.
const seen = new Map<string, Seen>();
// Bumped by each listing, so an older one that ends late is dropped.
let listRun = 0;
let listError: string | null = null;
// Taken synchronously by a switch or a set apply: one change at a time.
let isChanging = false;
let isReloading = false;
// The save-as-set form.
let isNaming = false;
let draftName = "";
let replaceName: string | null = null;
let setHint: string | null = null;

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : String(error);

/** The first non-empty line of a text, cut to a readable length. */
const firstLine = (text: string): string =>
  (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  ).slice(0, MAX_REASON);

/** Display text from a file we do not own: no control characters, one line. */
const cleanText = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  // eslint-disable-next-line no-control-regex
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text === "" ? null : text.slice(0, max);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const redraw = ($: Engine): void => {
  try {
    $.ui.invalidate("ui.render");
  } catch {
    // The next state change redraws instead.
  }
};

/** Reads one JSON file under a plugin's folder; undefined when absent or bad. */
const readJson = async (
  $: Engine,
  path: string,
): Promise<Record<string, unknown> | undefined> => {
  try {
    if (!(await $.fs.exists(path))) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(await $.fs.read(path));

    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** The merged `enabledPlugins` setting: id to on/off, empty when unreadable. */
const readEnabled = async ($: Engine): Promise<Record<string, unknown>> => {
  try {
    const value = await $.settings.read({ key: "enabledPlugins" });

    return isObject(value) ? value : {};
  } catch {
    return {};
  }
};

const splitId = (id: string): { name: string; marketplace: string | null } => {
  const at = id.lastIndexOf("@");

  return at <= 0
    ? { name: id, marketplace: null }
    : { name: id.slice(0, at), marketplace: id.slice(at + 1) };
};

const lockFor = (
  name: string,
  scope: ModScope | null,
  isManaged: boolean,
): ModLock | null => {
  if (name === SELF_NAME) {
    return "self";
  }

  if (isManaged) {
    return "managed";
  }

  return scope === "session" ? "session" : null;
};

const byName = (a: ModRow, b: ModRow): number =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** One plugin the CLI listed, with the two files read from its folder. */
export type ListedPlugin = {
  entry: Record<string, unknown> & { id: string };
  hooks: Record<string, unknown> | undefined;
  manifest: Record<string, unknown> | undefined;
};

const namesModule = (hooks: Record<string, unknown> | undefined): boolean =>
  Array.isArray(hooks?.modules) && hooks.modules.length > 0;

/**
 * Builds the pane's rows: the listed plugins kept to the mods (a hooks.json
 * naming a module, or a module seen by `plugin.register`), merged with what
 * this session saw and the enabled setting, plus the session's own mods the
 * CLI did not list. Pure, so it is tested on its own.
 */
export const buildRows = (
  listed: readonly ListedPlugin[],
  seenPlugins: ReadonlyMap<string, Seen>,
  enabled: Readonly<Record<string, unknown>>,
): ModRow[] => {
  const rows: ModRow[] = [];
  const ids = new Set<string>();

  for (const { entry, hooks, manifest } of listed) {
    const id = entry.id;
    const saw = seenPlugins.get(id);

    if (
      !ID_PATTERN.test(id) ||
      ids.has(id) ||
      (!namesModule(hooks) && saw?.hasModule !== true)
    ) {
      continue;
    }

    ids.add(id);
    const cliScope = typeof entry.scope === "string" ? entry.scope : null;
    const scope =
      cliScope !== null && LIST_SCOPES.includes(cliScope)
        ? (cliScope as ModScope)
        : null;
    const { name, marketplace } = splitId(id);
    const setting = enabled[id];
    const isOn =
      typeof setting === "boolean"
        ? setting
        : typeof entry.enabled === "boolean"
          ? entry.enabled
          : saw !== undefined;
    const isManaged = saw?.isManaged === true || cliScope === "managed";

    rows.push({
      id,
      name,
      marketplace,
      version:
        cleanText(entry.version, 40) ??
        saw?.version ??
        cleanText(manifest?.version, 40),
      description: cleanText(manifest?.description, MAX_DESCRIPTION),
      scope,
      isOn,
      lock: lockFor(name, scope, isManaged),
      problem: null,
    });
  }

  // Mods this session loaded that the CLI did not list: a `--plugin-dir` one,
  // or one the organization put in. Neither can be switched from here.
  for (const [id, saw] of seenPlugins) {
    const isInline = id.endsWith("@inline");

    if (
      ids.has(id) ||
      !saw.hasModule ||
      !ID_PATTERN.test(id) ||
      (!isInline && !saw.isManaged)
    ) {
      continue;
    }

    const { name, marketplace } = splitId(id);
    const scope: ModScope | null = isInline ? "session" : null;
    rows.push({
      id,
      name,
      marketplace,
      version: saw.version,
      description: null,
      scope,
      isOn: true,
      lock: lockFor(name, scope, saw.isManaged),
      problem: null,
    });
  }

  return rows.sort(byName);
};

/**
 * Lists the installed mods through the CLI, reading hooks.json and
 * plugin.json under each listed folder. Throws a short reason when the CLI
 * cannot list.
 */
const listMods = async ($: Engine): Promise<ModRow[]> => {
  const result = await $.process.run([CLI, "plugin", "list", "--json"], {
    timeoutMs: LIST_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      firstLine(result.stderr) ||
        firstLine(result.stdout) ||
        `exit code ${result.exitCode}`,
    );
  }

  let entries: unknown;

  try {
    entries = JSON.parse(result.stdout);
  } catch {
    throw new Error("the plugin list was not readable");
  }

  if (!Array.isArray(entries)) {
    throw new Error("the plugin list was not readable");
  }

  const listed: ListedPlugin[] = [];

  for (const entry of entries) {
    // Only a plain id leads to a file read; the rest is never shown.
    if (
      !isObject(entry) ||
      typeof entry.id !== "string" ||
      !ID_PATTERN.test(entry.id)
    ) {
      continue;
    }

    const folder =
      typeof entry.installPath === "string" &&
      entry.installPath !== "" &&
      !entry.installPath.includes("\0")
        ? entry.installPath.replace(/[\\/]+$/, "")
        : null;
    const hooks =
      folder === null
        ? undefined
        : await readJson($, `${folder}/hooks/hooks.json`);
    const isMod = namesModule(hooks) || seen.get(entry.id)?.hasModule === true;
    const manifest =
      folder === null || !isMod
        ? undefined
        : await readJson($, `${folder}/.claude-plugin/plugin.json`);

    listed.push({ entry: { ...entry, id: entry.id }, hooks, manifest });
  }

  return buildRows(listed, seen, await readEnabled($));
};

/** Lists again; a failure becomes the error row with Try again. */
const refresh = async ($: Engine): Promise<void> => {
  listRun += 1;
  const run = listRun;
  listError = null;

  try {
    await update($, isLoadingAtom, () => true);
    const rows = await listMods($);

    if (run === listRun) {
      await update($, modsAtom, () => rows);
    }
  } catch (error) {
    if (run === listRun) {
      listError = firstLine(errorMessage(error)) || "unknown error";
    }
  } finally {
    if (run === listRun) {
      try {
        await update($, isLoadingAtom, () => false);
      } catch {
        // Drawn again on the next change.
      }
      redraw($);
    }
  }
};

/** The reason a switch answer gives, or undefined when it says ok. */
const switchRefusal = (
  stdout: string,
  stderr: string,
  exitCode: number,
): string | undefined => {
  let answer: unknown;

  try {
    answer = JSON.parse(stdout);
  } catch {
    answer = undefined;
  }

  if (isObject(answer) && answer.outcome === "ok" && exitCode === 0) {
    return undefined;
  }

  const said = isObject(answer)
    ? (cleanText(answer.reason, MAX_REASON) ??
      cleanText(answer.message, MAX_REASON) ??
      cleanText(answer.error, MAX_REASON))
    : null;

  return (
    said ?? (firstLine(stderr) || firstLine(stdout) || `exit code ${exitCode}`)
  );
};

/**
 * Switches one mod in the scope it was installed in. The caller holds
 * `isChanging`. Returns whether it switched.
 */
const switchOne = async ($: Engine, row: ModRow): Promise<boolean> => {
  const listedIds = (await read($, modsAtom)).map((mod) => mod.id);

  // Checked before any process starts: a plain id from the last listing and
  // a scope the CLI writes to.
  if (
    row.lock !== null ||
    !ID_PATTERN.test(row.id) ||
    !listedIds.includes(row.id) ||
    row.scope === null ||
    !SWITCH_SCOPES.includes(row.scope)
  ) {
    $.ui.toast(`Could not switch ${row.name}: it cannot be switched from here`);

    return false;
  }

  const wantsOn = !row.isOn;
  await update($, busyIdAtom, () => row.id);

  try {
    const result = await $.process.run(
      [
        CLI,
        "plugin",
        wantsOn ? "enable" : "disable",
        row.id,
        "--scope",
        row.scope,
        "--json",
      ],
      { timeoutMs: SWITCH_TIMEOUT_MS },
    );
    const refusal = switchRefusal(
      result.stdout,
      result.stderr,
      result.exitCode,
    );

    if (refusal !== undefined) {
      $.ui.toast(`Could not switch ${row.name}: ${refusal}`);

      return false;
    }

    await update($, modsAtom, (mods) =>
      mods.map((mod) => (mod.id === row.id ? { ...mod, isOn: wantsOn } : mod)),
    );
    await update($, needsReloadAtom, () => true);

    return true;
  } catch (error) {
    $.ui.toast(
      `Could not switch ${row.name}: ${firstLine(errorMessage(error)) || "unknown error"}`,
    );

    return false;
  } finally {
    await update($, busyIdAtom, () => null);
  }
};

const pressSwitch = async ($: Engine, id: string): Promise<void> => {
  // Taken before any await, so a second press finds it held.
  if (isChanging) {
    return;
  }

  isChanging = true;

  try {
    const row = (await read($, modsAtom)).find((mod) => mod.id === id);

    if (row !== undefined && row.lock === null) {
      await switchOne($, row);
    }
  } catch {
    // switchOne tells the person; nothing else to do here.
  } finally {
    isChanging = false;
  }
};

const pressReload = async ($: Engine): Promise<void> => {
  if (isReloading) {
    return;
  }

  isReloading = true;

  try {
    // Cleared first: the reload may replace this module before it answers.
    await update($, needsReloadAtom, () => false);
    await $.command.run({ command: "reload-plugins" });
  } catch {
    try {
      await update($, needsReloadAtom, () => true);
    } catch {
      // The toast still tells the person.
    }
    $.ui.toast("Could not reload. Run /reload-plugins.");
  } finally {
    isReloading = false;
  }
};

const isSavedSet = (value: unknown): value is SavedSet =>
  isObject(value) &&
  typeof value.name === "string" &&
  SET_NAME_PATTERN.test(value.name) &&
  Array.isArray(value.on) &&
  value.on.every((id) => typeof id === "string");

const readSets = async ($: Engine): Promise<SavedSet[]> => {
  try {
    const stored = await $.store.get(SETS_KEY);

    return Array.isArray(stored)
      ? stored.filter(isSavedSet).slice(0, MAX_SETS)
      : [];
  } catch {
    return [];
  }
};

const writeSets = async ($: Engine, sets: SavedSet[]): Promise<boolean> => {
  try {
    await $.store.set(SETS_KEY, sets.slice(0, MAX_SETS));

    return true;
  } catch {
    $.ui.toast("Could not save the sets.");

    return false;
  }
};

const closeNaming = (): void => {
  isNaming = false;
  draftName = "";
  replaceName = null;
  setHint = null;
};

const pressSaveAs = ($: Engine): void => {
  isNaming = true;
  draftName = "";
  replaceName = null;
  setHint = null;
  redraw($);
};

const pressCancelNaming = ($: Engine): void => {
  closeNaming();
  redraw($);
};

const submitSetName = async ($: Engine, value: string): Promise<void> => {
  const name = value.trim();
  draftName = value;

  if (!SET_NAME_PATTERN.test(name)) {
    replaceName = null;
    setHint = "Use 1 to 30 letters, digits, spaces or dashes.";
    redraw($);

    return;
  }

  const sets = await readSets($);
  const isTaken = sets.some((set) => set.name === name);

  if (isTaken && replaceName !== name) {
    replaceName = name;
    setHint = `Press again to replace "${name}".`;
    redraw($);

    return;
  }

  // Only what can be switched belongs in a set.
  const on = (await read($, modsAtom))
    .filter((mod) => mod.isOn && mod.lock === null)
    .map((mod) => mod.id)
    .slice(0, MAX_SET_IDS);
  const next = isTaken
    ? sets.map((set) => (set.name === name ? { name, on } : set))
    : [...sets, { name, on }];

  if (await writeSets($, next)) {
    closeNaming();
  }

  redraw($);
};

const pressDeleteSet = async ($: Engine, name: string): Promise<void> => {
  const sets = await readSets($);
  await writeSets(
    $,
    sets.filter((set) => set.name !== name),
  );
  redraw($);
};

/**
 * Applies a set: switches only the mods whose state differs from it, one at
 * a time. Ids no longer installed are skipped and named.
 */
const pressApplySet = async ($: Engine, name: string): Promise<void> => {
  if (isChanging) {
    return;
  }

  isChanging = true;

  try {
    const set = (await readSets($)).find((one) => one.name === name);

    if (set === undefined) {
      return;
    }

    const mods = await read($, modsAtom);
    const installed = new Set(mods.map((mod) => mod.id));
    const missing = set.on.filter((id) => !installed.has(id));

    for (const row of mods) {
      if (row.lock === null && set.on.includes(row.id) !== row.isOn) {
        await switchOne($, row);
      }
    }

    if (missing.length > 0) {
      $.ui.toast(`Skipped, not installed any more: ${missing.join(", ")}`);
    }
  } catch {
    // switchOne tells the person about each failed switch.
  } finally {
    isChanging = false;
  }
};

const metaLine = (row: ModRow): string => {
  const parts: string[] = [];

  if (row.marketplace !== null) {
    parts.push(`@${row.marketplace}`);
  }

  if (row.version !== null) {
    parts.push(/^\d/.test(row.version) ? `v${row.version}` : row.version);
  }

  return parts.join(" · ");
};

export const register: Register = (on) => {
  // `seen` is left as it is: `plugin.register` for a plugin may come before
  // this step runs, and a stale entry only keeps a row that is still a mod.
  isChanging = false;
  isReloading = false;
  closeNaming();

  // Observed only: every plugin loads as it would have.
  on("plugin.register", ($, e, next) => {
    try {
      seen.set(e.provenance, {
        hasModule: e.provides.modules.length > 0,
        isManaged:
          e.requiredByOrganization === true ||
          e.tier === "prepend" ||
          e.tier === "append",
        version: cleanText(e.version, 40),
      });
    } catch {
      // A plugin the pane cannot read still loads.
    }

    return next(e);
  }).catch(($, e, next) => next(e));

  // Fires at the session's start and at every reload: it registers, never
  // resets, so the list and the reload line outlive a reload.
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: COMMAND_DESCRIPTION,
      });
    } catch {
      // Without the command the pane cannot open; nothing else breaks.
    }

    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    await $.ui.open({
      id: PANE_ID,
      title: PANE_TITLE,
      focus: true,
      closeOnEscape: true,
    });
    // Not awaited: the pane shows the loading row while the CLI lists.
    void refresh($);

    return { text: "Mods pane opened.", isTextDisplayOnly: true };
  }).catch(() => ({
    text: "Could not open the Mods pane.",
    isTextDisplayOnly: true as const,
  }));

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e);
    const mods = await read($, modsAtom);
    const isLoading = await read($, isLoadingAtom);
    const needsReload = await read($, needsReloadAtom);
    const busyId = await read($, busyIdAtom);
    const sets = isLoading || listError !== null ? [] : await readSets($);

    const reloadLine = needsReload && (
      <Box flexDirection="row">
        <Box flexShrink={1}>
          <Text wrap="truncate-end">Changes apply to new chats.</Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Button
            key="reload"
            label="Reload now"
            variant="primary"
            onPress={() => void pressReload($)}
          />
        </Box>
      </Box>
    );

    if (isLoading) {
      return (
        <Box flexDirection="column">
          {reloadLine}
          <Text dimColor>Looking for mods…</Text>
        </Box>
      );
    }

    if (listError !== null) {
      return (
        <Box flexDirection="column">
          {reloadLine}
          <Box flexDirection="row">
            <Box flexShrink={1}>
              <Text color={DANGER} wrap="truncate-end">
                Could not list mods: {listError}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Button
                key="retry"
                label="Try again"
                onPress={() => void refresh($)}
              />
            </Box>
          </Box>
        </Box>
      );
    }

    const rows = mods.map((row) => {
      const meta = metaLine(row);
      const control =
        row.lock !== null ? (
          <Text dimColor>{LOCK_TEXT[row.lock]}</Text>
        ) : (
          <Button key={row.id} onPress={() => void pressSwitch($, row.id)}>
            {busyId === row.id ? (
              <Text>…</Text>
            ) : row.isOn ? (
              <Text color={SUCCESS}>● on</Text>
            ) : (
              <Text dimColor>○ off</Text>
            )}
          </Button>
        );

      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row">
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row">
                <Box flexShrink={0}>
                  <Text weight="bold">{row.name}</Text>
                </Box>
                {meta !== "" && (
                  <Box flexShrink={1}>
                    <Text dimColor wrap="truncate-end">
                      {"  "}
                      {meta}
                    </Text>
                  </Box>
                )}
              </Box>
              {row.description !== null && (
                <Text wrap="truncate-end">{row.description}</Text>
              )}
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              {control}
            </Box>
          </Box>
          {row.problem !== null && (
            <Text color={DANGER} wrap="truncate-end">
              {row.problem}
            </Text>
          )}
        </Box>
      );
    });

    return (
      <Box flexDirection="column">
        {reloadLine}
        {mods.length === 0 ? <Text dimColor>No mods installed.</Text> : rows}
        <Text weight="bold">Sets</Text>
        {sets.length === 0 && <Text dimColor>No sets saved yet.</Text>}
        {sets.map((set) => (
          <Box flexDirection="row">
            <Box flexShrink={1} flexGrow={1}>
              <Text wrap="truncate-end">{set.name}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Button
                key={`apply:${set.name}`}
                label="Apply"
                onPress={() => void pressApplySet($, set.name)}
              />
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Button
                key={`delete:${set.name}`}
                label="Delete"
                onPress={() => void pressDeleteSet($, set.name)}
              />
            </Box>
          </Box>
        ))}
        {isNaming ? (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Box flexGrow={1} flexShrink={1}>
                <Input
                  key="set-name"
                  label="Set name "
                  placeholder="for example recording"
                  value={draftName}
                  submitLabel="save"
                  autoFocus
                  onSubmit={(value) => void submitSetName($, value)}
                />
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                <Button
                  key="cancel-set"
                  label="Cancel"
                  onPress={() => pressCancelNaming($)}
                />
              </Box>
            </Box>
            {setHint !== null && <Text dimColor>{setHint}</Text>}
          </Box>
        ) : (
          <Box flexDirection="row">
            <Button
              key="save-set"
              label="Save as set"
              onPress={() => pressSaveAs($)}
            />
          </Box>
        )}
      </Box>
    );
  });
};
