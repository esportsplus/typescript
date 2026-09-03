import * as NodePath from 'node:path';

import { readGuardConfig } from '~/tsconfig';
import { stripJsonc } from '~/jsonc';

import type {
    ChannelConfig,
    Severity,
    AnalyzeConfig,
} from './types';

// The known channel names. `tsc-guard`'s keys are exactly these; any other key
// is rejected so a typo fails loudly instead of silently disabling a check.
const CHANNEL_NAMES = ['exceptions', 'resources', 'async'] as const;

const SEVERITIES = ['error', 'info', 'off', 'warn'] as const;

const OPTION_KEYS: Readonly<Record<string, ReadonlyArray<string>>> = {
    async: [],
    exceptions: ['report'],
    resources: [],
};

type RawConfig = Record<string, unknown>;

function fail(message: string): never {
    throw new Error(`analyze config: ${message}`);
}

// A merged `null` (from a deep-merge that deletes an inherited key) reads as an
// absent value at every level.
function absent(value: unknown): boolean {
    return value === undefined || value === null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSeverity(value: unknown, channel: string): Severity {
    if (absent(value)) {
        return 'error';
    }
    if (!(SEVERITIES as ReadonlyArray<unknown>).includes(value)) {
        fail(`${channel}.severity must be "error", "warn", "info", or "off"`);
    }
    return value as Severity;
}

function parseChannel(name: string, raw: unknown): ChannelConfig {
    if (!isPlainObject(raw)) {
        fail(`${name} must be an object`);
    }
    const options: Record<string, unknown> = {};
    for (const key of Object.keys(raw)) {
        if (key === 'severity' || absent(raw[key])) {
            continue;
        }
        if (!OPTION_KEYS[name]!.includes(key)) {
            fail(`${name}.${key} is not a supported option`);
        }
        options[key] = raw[key];
    }
    return { severity: parseSeverity(raw['severity'], name), options };
}

// Turn the raw parsed `tsc-guard` object into a validated, defaulted config.
// Pure — no I/O — so it is directly testable. `projectRoot` anchors the config.
// A present channel defaults to `severity: "error"`; an absent one is "off".
function normalizeConfig(raw: RawConfig, projectRoot: string): AnalyzeConfig {
    if (!isPlainObject(raw)) {
        fail(`root must be a JSON object`);
    }
    for (const key of Object.keys(raw)) {
        if (absent(raw[key])) {
            continue;
        }
        if (!(CHANNEL_NAMES as ReadonlyArray<string>).includes(key)) {
            fail(`unknown channel "${key}" (known: ${CHANNEL_NAMES.join(', ')})`);
        }
    }
    const channels: Record<string, ChannelConfig> = {};
    for (const name of CHANNEL_NAMES) {
        channels[name] = absent(raw[name])
            ? { severity: 'off', options: {} }
            : parseChannel(name, raw[name]);
    }
    return {
        projectRoot,
        // Always overridden by loadConfigFromTsconfig with the invoking tsconfig;
        // this default only applies to direct configFromObject/parseConfig use.
        tsconfigPath: NodePath.join(projectRoot, 'tsconfig.json'),
        channels,
    };
}

// Parse config text (JSONC) into a validated config anchored at `projectRoot`.
function parseConfig(text: string, projectRoot: string): AnalyzeConfig {
    let parsed: RawConfig;
    try {
        parsed = JSON.parse(stripJsonc(text)) as RawConfig;
    } catch (error) {
        fail(`invalid JSONC: ${(error as Error).message}`);
    }
    return normalizeConfig(parsed, projectRoot);
}

// Validate an already-parsed config object (the merged `tsc-guard` key from
// tsconfig.json) anchored at `projectRoot`.
function configFromObject(raw: unknown, projectRoot: string): AnalyzeConfig {
    return normalizeConfig((raw ?? {}) as RawConfig, projectRoot);
}

function loadConfigFromTsconfig(
    tsconfigPath: string,
): AnalyzeConfig | undefined {
    const resolved = NodePath.resolve(tsconfigPath);
    const guard = readGuardConfig(resolved);
    if (!guard) {
        return undefined;
    }
    return {
        ...configFromObject(guard, NodePath.dirname(resolved)),
        tsconfigPath: resolved,
    };
}


export { configFromObject, loadConfigFromTsconfig, parseConfig };
