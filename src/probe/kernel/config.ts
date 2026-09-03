import * as NodePath from 'node:path';

import { readProbeConfig } from '~/tsconfig';
import { stripJsonc } from '~/jsonc';

import type {
    ChannelConfig,
    Dispatch,
    Severity,
    AnalyzeConfig,
} from './types';

// The known channel names. `tsc-probe`'s keys are exactly these; any other key
// is rejected so a typo fails loudly instead of silently disabling a check.
const CHANNEL_NAMES = ['exceptions', 'resources', 'async'] as const;

// Removed user-facing keys, each mapped to the diagnostic naming its replacement.
// Effect models are built in and analysis is always whole-project, so none of
// these are configurable any longer.
const LEGACY_KEYS: Readonly<Record<string, string>> = {
    channels: '"channels" wrapper removed — put channels at the tsc-probe root',
    enabled: '"enabled" removed — use "severity": "off"',
    entryPoints:
        '"sinks"/"handlerBoundaries"/"entryPoints" removed — analysis is always whole-project',
    failOnFindings:
        'top-level "severity"/"failOnFindings" moved into each channel as "severity"',
    handlerBoundaries:
        '"sinks"/"handlerBoundaries"/"entryPoints" removed — analysis is always whole-project',
    overlays:
        '"presets"/"overlays" are no longer configurable — platform models are built in',
    presets:
        '"presets"/"overlays" are no longer configurable — platform models are built in',
    severity:
        'top-level "severity"/"failOnFindings" moved into each channel as "severity"',
    sinks: '"sinks"/"handlerBoundaries"/"entryPoints" removed — analysis is always whole-project',
};

const SEVERITIES = ['error', 'off', 'warn'] as const;

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

function parseDispatch(value: unknown, channel: string): Dispatch {
    if (absent(value)) {
        return 'optimist';
    }
    if (value !== 'optimist' && value !== 'pessimist') {
        fail(`${channel}.dispatch must be "optimist" or "pessimist"`);
    }
    return value;
}

function parseSeverity(value: unknown, channel: string): Severity {
    if (absent(value)) {
        return 'error';
    }
    if (!(SEVERITIES as ReadonlyArray<unknown>).includes(value)) {
        fail(`${channel}.severity must be "error", "warn", or "off"`);
    }
    return value as Severity;
}

function parseChannel(name: string, raw: unknown): ChannelConfig {
    if (!isPlainObject(raw)) {
        fail(`${name} must be an object`);
    }
    if ('enabled' in raw && !absent(raw['enabled'])) {
        fail(`${name}.enabled removed — use "severity": "off"`);
    }
    const options: Record<string, unknown> = {};
    for (const key of Object.keys(raw)) {
        if (key === 'severity' || key === 'dispatch' || key === 'enabled') {
            continue;
        }
        if (absent(raw[key])) {
            continue;
        }
        options[key] = raw[key];
    }
    // `fanOut` is a boolean; the channel severity governs the finding level. The
    // old "off"|"warn"|"error" strings are rejected as a config error.
    if (
        name === 'async' &&
        options['fanOut'] !== undefined &&
        typeof options['fanOut'] !== 'boolean'
    ) {
        fail(
            'async.fanOut must be a boolean — the "off"|"warn"|"error" strings are replaced by the channel "severity"',
        );
    }
    return {
        severity: parseSeverity(raw['severity'], name),
        dispatch: parseDispatch(raw['dispatch'], name),
        options,
    };
}

// Turn the raw parsed `tsc-probe` object into a validated, defaulted config.
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
        const legacy = LEGACY_KEYS[key];
        if (legacy !== undefined) {
            fail(legacy);
        }
        if (!(CHANNEL_NAMES as ReadonlyArray<string>).includes(key)) {
            fail(`unknown channel "${key}" (known: ${CHANNEL_NAMES.join(', ')})`);
        }
    }
    const channels: Record<string, ChannelConfig> = {};
    for (const name of CHANNEL_NAMES) {
        channels[name] = absent(raw[name])
            ? { severity: 'off', dispatch: 'optimist', options: {} }
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

// Validate an already-parsed config object (the merged `tsc-probe` key from
// tsconfig.json) anchored at `projectRoot`.
function configFromObject(raw: unknown, projectRoot: string): AnalyzeConfig {
    return normalizeConfig((raw ?? {}) as RawConfig, projectRoot);
}

function loadConfigFromTsconfig(
    tsconfigPath: string,
): AnalyzeConfig | undefined {
    const resolved = NodePath.resolve(tsconfigPath);
    const probe = readProbeConfig(resolved);
    if (!probe) {
        return undefined;
    }
    return {
        ...configFromObject(probe, NodePath.dirname(resolved)),
        tsconfigPath: resolved,
    };
}


export { configFromObject, loadConfigFromTsconfig, parseConfig };
