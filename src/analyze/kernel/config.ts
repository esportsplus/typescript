import * as NodeFS from "node:fs";
import * as NodePath from "node:path";


import type {
  ChannelConfig,
  Dispatch,
  HandlerBoundary,
  SinkConfig,
  AnalyzeConfig,
} from "./types";

// The known channel names. Config for any other key is rejected so typos fail
// loudly instead of silently disabling a check.
const CHANNEL_NAMES = ["exceptions", "resources", "async", "context"] as const;

const DEFAULT_ENABLED: Readonly<Record<string, boolean>> = {
  exceptions: true,
  resources: false,
  async: false,
  context: false,
};

interface RawConfig {
  entryPoints?: unknown;
  tsconfig?: unknown;
  handlerBoundaries?: unknown;
  sinks?: unknown;
  presets?: unknown;
  overlays?: unknown;
  channels?: unknown;
  failOnFindings?: unknown;
  severity?: unknown;
}

function fail(message: string): never {
  throw new Error(`analyze config: ${message}`);
}

// Strip line/block comments and trailing commas so JSON.parse accepts JSONC.
// String-literal aware so `"http://"` and `"a,]"` survive intact.
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let inString = false;
  let quote = "";
  while (i < n) {
    const ch = text[i]!;
    const next = i + 1 < n ? text[i + 1]! : "";
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Drop trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function asStringArray(value: unknown, field: string): ReadonlyArray<string> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`"${field}" must be an array of strings`);
  }
  return value as ReadonlyArray<string>;
}

function parseHandlerBoundaries(value: unknown): ReadonlyArray<HandlerBoundary> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`"handlerBoundaries" must be an array`);
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      fail(`handlerBoundaries[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry["callee"] !== "string") {
      fail(`handlerBoundaries[${index}].callee must be a string`);
    }
    const callbackArgs = entry["callbackArgs"];
    if (
      !Array.isArray(callbackArgs) ||
      callbackArgs.some((v) => typeof v !== "number" || !Number.isInteger(v))
    ) {
      fail(`handlerBoundaries[${index}].callbackArgs must be an array of integers`);
    }
    return {
      callee: entry["callee"] as string,
      callbackArgs: callbackArgs as ReadonlyArray<number>,
    };
  });
}

function parseSinks(value: unknown): ReadonlyArray<SinkConfig> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`"sinks" must be an array`);
  }
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      fail(`sinks[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry["callee"] !== "string") {
      fail(`sinks[${index}].callee must be a string`);
    }
    let absorbs: ReadonlyArray<string> | undefined;
    if (entry["absorbs"] !== undefined) {
      absorbs = asStringArray(entry["absorbs"], `sinks[${index}].absorbs`);
    }
    return { callee: entry["callee"] as string, absorbs };
  });
}

function parseDispatch(value: unknown, channel: string): Dispatch {
  if (value === undefined) {
    return "optimist";
  }
  if (value !== "optimist" && value !== "pessimist") {
    fail(`channels.${channel}.dispatch must be "optimist" or "pessimist"`);
  }
  return value;
}

function parseChannels(value: unknown): Record<string, ChannelConfig> {
  const channels: Record<string, ChannelConfig> = {};
  const raw =
    value === undefined ? {} : (value as Record<string, unknown>);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`"channels" must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!(CHANNEL_NAMES as ReadonlyArray<string>).includes(key)) {
      fail(`unknown channel "${key}" (known: ${CHANNEL_NAMES.join(", ")})`);
    }
  }
  for (const name of CHANNEL_NAMES) {
    const entry = (raw[name] ?? {}) as Record<string, unknown>;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(`channels.${name} must be an object`);
    }
    const enabled =
      entry["enabled"] === undefined
        ? DEFAULT_ENABLED[name]!
        : entry["enabled"];
    if (typeof enabled !== "boolean") {
      fail(`channels.${name}.enabled must be a boolean`);
    }
    const { enabled: _e, dispatch: _d, ...options } = entry;
    channels[name] = {
      enabled,
      dispatch: parseDispatch(entry["dispatch"], name),
      options,
    };
  }
  return channels;
}

// Turn raw parsed JSONC into a validated, defaulted config. Pure — no I/O — so
// it is directly testable. `projectRoot` anchors relative paths.
function normalizeConfig(raw: RawConfig, projectRoot: string): AnalyzeConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`root must be a JSON object`);
  }
  const tsconfig =
    raw.tsconfig === undefined ? "tsconfig.json" : raw.tsconfig;
  if (typeof tsconfig !== "string") {
    fail(`"tsconfig" must be a string`);
  }
  return {
    projectRoot,
    tsconfigPath: NodePath.resolve(projectRoot, tsconfig),
    entryPoints: asStringArray(raw.entryPoints, "entryPoints"),
    handlerBoundaries: parseHandlerBoundaries(raw.handlerBoundaries),
    sinks: parseSinks(raw.sinks),
    presets: asStringArray(raw.presets, "presets"),
    overlays: asStringArray(raw.overlays, "overlays").map((p) =>
      NodePath.resolve(projectRoot, p),
    ),
    channels: parseChannels(raw.channels),
    failOnFindings: raw.failOnFindings === true,
    severity: raw.severity === "warn" || raw.severity === "warning" ? "warning" : "error",
  };
}

// Parse config text (JSONC) into a validated config anchored at `projectRoot`.
export function parseConfig(text: string, projectRoot: string): AnalyzeConfig {
  let parsed: RawConfig;
  try {
    parsed = JSON.parse(stripJsonc(text)) as RawConfig;
  } catch (error) {
    fail(`invalid JSONC: ${(error as Error).message}`);
  }
  return normalizeConfig(parsed, projectRoot);
}

// Validate an already-parsed config object (e.g. the tsserver plugin entry in
// tsconfig.json, minus its `name`) anchored at `projectRoot`.
export function configFromObject(raw: unknown, projectRoot: string): AnalyzeConfig {
  return normalizeConfig(raw as RawConfig, projectRoot);
}

// Read the analyze config from a tsconfig.json's `plugins: [{ name: "analyze", … }]`
// entry — the same inline config the language-service plugin uses, so the CLI and
// editor share one source. Returns undefined when there is no analyze plugin entry.
// The resolved config's `tsconfigPath` points back at this tsconfig.
// Read `compilerOptions.plugins` from a tsconfig, following relative `extends`.
function readTsconfigPlugins(
  tsconfigPath: string,
  seen: Set<string>,
): ReadonlyArray<{ name?: unknown }> | undefined {
  const id = NodePath.resolve(tsconfigPath);
  if (seen.has(id) || !NodeFS.existsSync(id)) {
    return undefined;
  }
  seen.add(id);
  let raw: { compilerOptions?: { plugins?: unknown }; extends?: unknown };
  try {
    raw = JSON.parse(stripJsonc(NodeFS.readFileSync(id, "utf8")));
  } catch {
    return undefined;
  }
  let plugins: ReadonlyArray<{ name?: unknown }> | undefined;
  if (raw.extends !== undefined) {
    const bases = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
    for (const base of bases) {
      if (typeof base !== "string" || !base.startsWith(".")) {
        continue; // package `extends` are not followed for plugin discovery
      }
      const target = NodePath.resolve(NodePath.dirname(id), base.endsWith(".json") ? base : `${base}.json`);
      const inherited = readTsconfigPlugins(target, seen);
      if (inherited) {
        plugins = inherited;
      }
    }
  }
  if (Array.isArray(raw.compilerOptions?.plugins)) {
    plugins = raw.compilerOptions.plugins as ReadonlyArray<{ name?: unknown }>;
  }
  return plugins;
}

export function loadConfigFromTsconfig(tsconfigPath: string): AnalyzeConfig | undefined {
  const resolved = NodePath.resolve(tsconfigPath);
  const plugins = readTsconfigPlugins(resolved, new Set()) ?? [];
  const entry = plugins.find((p) => p !== null && typeof p === "object" && p.name === "analyze");
  if (!entry) {
    return undefined;
  }
  return { ...configFromObject(entry, NodePath.dirname(resolved)), tsconfigPath: resolved };
}

// Load and validate analyze.config.jsonc found at or above `startDir`.
export function loadConfig(configPath: string): AnalyzeConfig {
  if (!NodeFS.existsSync(configPath)) {
    fail(`no config file at ${configPath}`);
  }
  const text = NodeFS.readFileSync(configPath, "utf8");
  return parseConfig(text, NodePath.dirname(configPath));
}

export const KNOWN_CHANNELS = CHANNEL_NAMES;
