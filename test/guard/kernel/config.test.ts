import { describe, expect, it } from "vitest";

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configFromObject, loadConfigFromTsconfig, parseConfig } from "~/guard/kernel/config";
import { stripJsonc } from '~/jsonc';

let ROOT = "/project";

describe("kernel config — JSONC parsing", () => {
    it("strips comments and trailing commas but preserves comment-like text in strings", () => {
        let text = `{
    // a line comment
    "exceptions": { "severity": "error", "report": "a/*keep*/b" }, /* trailing */
}`;
        let config = parseConfig(text, ROOT);
        expect(config.channels["exceptions"]!.severity).toBe("error");
        expect(config.channels["exceptions"]!.options).toEqual({ report: "a/*keep*/b" });
    });

    it("preserves comma-like text inside strings while stripping trailing commas", () => {
        expect(JSON.parse(stripJsonc('{"a":"x,]","b":[1,],}'))).toEqual({ a: "x,]", b: [1] });
    });

    it("throws a prefixed error on invalid JSONC", () => {
        expect(() => parseConfig("{ not json", ROOT)).toThrow(/analyze config: invalid JSONC/);
    });
});

describe("kernel config — severity defaults", () => {
    it("makes every absent channel off, so a bare {} analyzes nothing", () => {
        let config = configFromObject({}, ROOT);
        expect(config.channels["exceptions"]!.severity).toBe("off");
        expect(config.channels["resources"]!.severity).toBe("off");
        expect(config.channels["async"]!.severity).toBe("off");
    });

    it("defaults a present channel with no severity to error", () => {
        expect(configFromObject({ exceptions: {} }, ROOT).channels["exceptions"]!.severity).toBe("error");
    });

    it("honors explicit warn and off", () => {
        let config = configFromObject({ async: { severity: "warn" }, resources: { severity: "off" } }, ROOT);
        expect(config.channels["async"]!.severity).toBe("warn");
        expect(config.channels["resources"]!.severity).toBe("off");
    });

    it("rejects an unknown severity", () => {
        expect(() => configFromObject({ async: { severity: "loud" } }, ROOT)).toThrow(/severity must be "error", "warn", "info", or "off"/);
    });
});

describe("kernel config — channels and options", () => {
    it("collects non-severity keys as opaque channel options", () => {
        let config = configFromObject(
            { exceptions: { severity: "error", report: "all" } },
            ROOT,
        );
        expect(config.channels["exceptions"]!.options).toEqual({ report: "all" });
    });

    it("rejects an unknown channel", () => {
        expect(() => configFromObject({ bogus: {} }, ROOT)).toThrow(/unknown channel "bogus"/);
    });

    it("rejects unsupported options on every channel", () => {
        expect(() => configFromObject({ exceptions: { dispatch: "optimist" } }, ROOT)).toThrow(/exceptions\.dispatch is not a supported option/);
        expect(() => configFromObject({ resources: { dispatch: "optimist" } }, ROOT)).toThrow(/resources\.dispatch is not a supported option/);
        expect(() => configFromObject({ async: { dispatch: "optimist" } }, ROOT)).toThrow(/async\.dispatch is not a supported option/);
    });

    it("rejects removed channel options with the uniform message", () => {
        expect(() => configFromObject({ async: { fanOut: true } }, ROOT)).toThrow(/async\.fanOut is not a supported option/);
        expect(() => configFromObject({ async: { fanOutAllowLiteralUpTo: 8 } }, ROOT)).toThrow(/async\.fanOutAllowLiteralUpTo is not a supported option/);
        expect(() => configFromObject({ async: { poolFunctions: ["p-map"] } }, ROOT)).toThrow(/async\.poolFunctions is not a supported option/);
        expect(() => configFromObject({ resources: { ownership: [] } }, ROOT)).toThrow(/resources\.ownership is not a supported option/);
        expect(() => configFromObject({ exceptions: { errorCause: true } }, ROOT)).toThrow(/exceptions\.errorCause is not a supported option/);
    });
});

describe("kernel config — legacy key rejection", () => {
    const CASES: ReadonlyArray<[string, unknown, RegExp]> = [
        ["presets", ["node"], /unknown channel "presets"/],
        ["overlays", ["x.jsonc"], /unknown channel "overlays"/],
        ["channels", { exceptions: {} }, /unknown channel "channels"/],
        ["severity", "error", /unknown channel "severity"/],
        ["failOnFindings", true, /unknown channel "failOnFindings"/],
        ["sinks", [], /unknown channel "sinks"/],
        ["handlerBoundaries", [], /unknown channel "handlerBoundaries"/],
        ["entryPoints", [], /unknown channel "entryPoints"/],
    ];

    for (const [key, value, re] of CASES) {
        it(`rejects the removed "${key}" root key`, () => {
            expect(() => configFromObject({ [key]: value }, ROOT)).toThrow(re);
        });
    }

    it('rejects a per-channel "enabled" option', () => {
        expect(() => configFromObject({ exceptions: { enabled: false } }, ROOT)).toThrow(/exceptions\.enabled is not a supported option/);
    });
});

describe("kernel config — tsconfig discovery and merge", () => {
    it("inherits the tsc-guard key through a package extends entry", () => {
        let dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-config-")),
            pkg = path.join(dir, "node_modules", "shared-config"),
            tsconfig = path.join(dir, "tsconfig.json");

        try {
            fs.mkdirSync(pkg, { recursive: true });
            fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "shared-config" }));
            fs.writeFileSync(path.join(pkg, "tsconfig.json"), JSON.stringify({
                "tsc-guard": { exceptions: { severity: "error", report: "cross-module" } },
            }));
            fs.writeFileSync(tsconfig, JSON.stringify({ extends: "shared-config/tsconfig.json" }));

            let config = loadConfigFromTsconfig(tsconfig);

            expect(config?.channels["exceptions"]!.severity).toBe("error");
            expect(config?.channels["exceptions"]!.options).toEqual({ report: "cross-module" });
        }
        finally {
            fs.rmSync(dir, { force: true, recursive: true });
        }
    });

    it("deep-merges a nested override and treats a null value as a delete", () => {
        let dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-config-")),
            pkg = path.join(dir, "node_modules", "shared-config"),
            tsconfig = path.join(dir, "tsconfig.json");

        try {
            fs.mkdirSync(pkg, { recursive: true });
            fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "shared-config" }));
            fs.writeFileSync(path.join(pkg, "tsconfig.json"), JSON.stringify({
                "tsc-guard": {
                    exceptions: { severity: "error", report: "cross-module" },
                    resources: { severity: "error" },
                },
            }));
            fs.writeFileSync(tsconfig, JSON.stringify({
                extends: "shared-config/tsconfig.json",
                "tsc-guard": { exceptions: { report: "consumers" }, resources: null },
            }));

            let config = loadConfigFromTsconfig(tsconfig);

            // The child overrides only `report`.
            expect(config?.channels["exceptions"]!.options).toEqual({ report: "consumers" });
            // `null` deletes the inherited `resources` channel, so it is off.
            expect(config?.channels["resources"]!.severity).toBe("off");
        }
        finally {
            fs.rmSync(dir, { force: true, recursive: true });
        }
    });
});
