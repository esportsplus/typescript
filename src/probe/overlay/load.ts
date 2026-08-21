import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as ts from "~/probe/adapter";

import type {
  HandlerBoundary,
  OverlayLookup,
  OverlaySet,
  AnalyzeConfig,
} from "../kernel/types";

// Namespace-like globals whose members read as `Global.member` instead of
// `Interface#method`. The `Constructor` suffix on the declaring interface
// (e.g. NumberConstructor) is stripped before this check, so `Number.parseInt`
// resolves here while `Array#map` does not.
const KNOWN_NAMESPACES = new Set([
  "JSON",
  "Math",
  "Object",
  "Reflect",
  "Number",
  "Console",
  "console",
]);

// A section's symbol->entry table, and a channel's section tables.
type SectionTable = Map<string, unknown>;
type ChannelTable = Map<string, SectionTable>;

export interface MergedOverlay {
  // channel -> section -> overlayKey -> raw entry
  readonly channels: ReadonlyMap<string, ChannelTable>;
  readonly boundaries: ReadonlyArray<HandlerBoundary>;
  entry(channel: string, section: string, key: string): unknown;
}

export interface LoadedOverlays extends OverlaySet {
  boundariesFromPresets(): ReadonlyArray<HandlerBoundary>;
}

// ---------------------------------------------------------------------------
// JSONC parsing (inlined so this subsystem stays extractable by directory move)
// ---------------------------------------------------------------------------

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
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseJsonc(name: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (error) {
    throw new Error(`analyze overlay: invalid JSONC in ${name}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`analyze overlay: ${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Merge (pure — no checker; directly testable)
// ---------------------------------------------------------------------------

function isSectionMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSections(into: ChannelTable, sections: Record<string, unknown>): void {
  for (const [section, keys] of Object.entries(sections)) {
    if (!isSectionMap(keys)) {
      continue;
    }
    let table = into.get(section);
    if (!table) {
      table = new Map();
      into.set(section, table);
    }
    for (const [key, entry] of Object.entries(keys)) {
      table.set(key, entry); // later file wins
    }
  }
}

function readBoundaries(name: string, raw: unknown): HandlerBoundary[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`analyze overlay: ${name} handlerBoundaries must be an array`);
  }
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`analyze overlay: ${name} handlerBoundaries[${index}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    const callee = obj["callee"];
    const callbackArgs = obj["callbackArgs"];
    if (typeof callee !== "string") {
      throw new Error(`analyze overlay: ${name} handlerBoundaries[${index}].callee must be a string`);
    }
    if (
      !Array.isArray(callbackArgs) ||
      callbackArgs.some((v) => typeof v !== "number" || !Number.isInteger(v))
    ) {
      throw new Error(
        `analyze overlay: ${name} handlerBoundaries[${index}].callbackArgs must be an array of integers`,
      );
    }
    return { callee, callbackArgs: callbackArgs as ReadonlyArray<number> };
  });
}

// Merge overlay files in precedence order (later wins). A file is either a
// bundle (has `overlay`/`handlerBoundaries`) or a bare exceptions section map.
export function mergeOverlayData(files: ReadonlyArray<{ name: string; text: string }>): MergedOverlay {
  const channels = new Map<string, ChannelTable>();
  const boundaries: HandlerBoundary[] = [];

  const channelFor = (channel: string): ChannelTable => {
    let table = channels.get(channel);
    if (!table) {
      table = new Map();
      channels.set(channel, table);
    }
    return table;
  };

  for (const file of files) {
    const root = parseJsonc(file.name, file.text);
    const isBundle = "overlay" in root || "handlerBoundaries" in root;
    if (isBundle) {
      boundaries.push(...readBoundaries(file.name, root["handlerBoundaries"]));
      const overlay = root["overlay"];
      if (overlay !== undefined) {
        if (!isSectionMap(overlay)) {
          throw new Error(`analyze overlay: ${file.name} overlay must be an object`);
        }
        for (const [channel, sections] of Object.entries(overlay)) {
          if (isSectionMap(sections)) {
            mergeSections(channelFor(channel), sections);
          }
        }
      }
    } else {
      // Bare file: top-level sections belong to the exceptions channel.
      mergeSections(channelFor("exceptions"), root);
    }
  }

  return {
    channels,
    boundaries,
    entry(channel, section, key) {
      return channels.get(channel)?.get(section)?.get(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Key format (pure — directly testable)
// ---------------------------------------------------------------------------

// Build the overlay key. Discriminator: a namespace-like parent (JSON, Math,
// Number, ...) yields `Parent.member`; any other interface parent yields
// `Interface#method`; no parent yields the bare global name.
export function overlayKey(
  parentName: string | undefined,
  memberName: string,
  isNamespace: boolean,
): string {
  if (!parentName) {
    return memberName;
  }
  return isNamespace ? `${parentName}.${memberName}` : `${parentName}#${memberName}`;
}

function stripConstructor(name: string): string {
  return name.endsWith("Constructor") ? name.slice(0, -"Constructor".length) : name;
}

// ---------------------------------------------------------------------------
// Checker -> key resolution
// ---------------------------------------------------------------------------

function declaredParentName(symbol: ts.Symbol): string | undefined {
  for (const decl of ts.symbolDeclarations(symbol)) {
    const parent = decl.parent;
    if (parent && (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent))) {
      return parent.name?.text;
    }
  }
  return undefined;
}

// Section-name convention: a lib file `lib.<x>[.<sub>].d.ts` collapses to
// `lib.<x>` (so `lib.es2015.core.d.ts` -> `lib.es2015`). A node type/module
// file `<mod>.d.ts` under @types/node (or a `node:` module) -> `node:<mod>`.
interface SourceHint {
  kind: "lib" | "node" | "other";
  section: string | undefined;
}

function sourceHint(symbol: ts.Symbol): SourceHint {
  for (const decl of ts.symbolDeclarations(symbol)) {
    const file = decl.getSourceFile().fileName;
    const base = NodePath.basename(file);
    const libMatch = /^(lib(?:\.[a-z0-9]+){1,})\.d\.ts$/.exec(base);
    if (libMatch) {
      const parts = libMatch[1]!.split(".");
      return { kind: "lib", section: parts.slice(0, 2).join(".") };
    }
    const normalized = file.replace(/\\/g, "/");
    if (normalized.includes("@types/node/") || normalized.includes("/node_modules/node/")) {
      return { kind: "node", section: `node:${base.replace(/\.d\.ts$/, "")}` };
    }
  }
  return { kind: "other", section: undefined };
}

function keyFor(symbol: ts.Symbol): string {
  const parent = declaredParentName(symbol);
  const stripped = parent ? stripConstructor(parent) : undefined;
  const isNamespace = stripped ? KNOWN_NAMESPACES.has(stripped) : false;
  return overlayKey(stripped, symbol.name, isNamespace);
}

function findInSections(
  channel: ChannelTable,
  key: string,
  accept: (section: string) => boolean,
  preferred: string | undefined,
): OverlayLookup | undefined {
  if (preferred) {
    const table = channel.get(preferred);
    if (table && table.has(key)) {
      return { pkg: preferred, symbol: key, entry: table.get(key) };
    }
  }
  for (const [section, table] of channel) {
    if (section === preferred || !accept(section)) {
      continue;
    }
    if (table.has(key)) {
      return { pkg: section, symbol: key, entry: table.get(key) };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

function readFile(file: string): { name: string; text: string } {
  return { name: file, text: NodeFS.readFileSync(file, "utf8") };
}

export function loadOverlays(config: AnalyzeConfig): LoadedOverlays {
  const files: Array<{ name: string; text: string }> = [];
  files.push(readFile(NodePath.join(HERE, "base", "async.jsonc")));
  files.push(readFile(NodePath.join(HERE, "base", "exceptions.jsonc")));
  for (const preset of config.presets) {
    const presetPath = NodePath.join(HERE, "presets", `${preset}.jsonc`);
    if (!NodeFS.existsSync(presetPath)) {
      throw new Error(`analyze overlay: unknown preset "${preset}" (no file at ${presetPath})`);
    }
    files.push(readFile(presetPath));
  }
  for (const overlay of config.overlays) {
    if (!NodeFS.existsSync(overlay)) {
      throw new Error(`analyze overlay: overlay file not found: ${overlay}`);
    }
    files.push(readFile(overlay));
  }

  const merged = mergeOverlayData(files);

  return {
    boundariesFromPresets() {
      return merged.boundaries;
    },
    lookup(symbol, _checker, channel) {
      const table = merged.channels.get(channel);
      if (!table) {
        return undefined;
      }
      const key = keyFor(symbol);
      const hint = sourceHint(symbol);
      if (hint.kind === "lib") {
        return findInSections(table, key, (s) => s.startsWith("lib."), hint.section);
      }
      if (hint.kind === "node") {
        return findInSections(table, key, (s) => s.startsWith("node:"), hint.section);
      }
      return findInSections(table, key, (s) => !s.startsWith("lib."), undefined);
    },
  };
}
