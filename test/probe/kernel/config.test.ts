import { describe, expect, it } from "vitest";

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configFromObject, loadConfigFromTsconfig, parseConfig } from "~/probe/kernel/config";
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
        expect(() => configFromObject({ async: { severity: "loud" } }, ROOT)).toThrow(/severity must be "error", "warn", or "off"/);
    });
});

describe("kernel config — channels and options", () => {
    it("collects non-severity/dispatch keys as opaque channel options", () => {
        let config = configFromObject(
            { exceptions: { severity: "error", dispatch: "pessimist", report: "all", errorCause: true } },
            ROOT,
        );
        expect(config.channels["exceptions"]!.dispatch).toBe("pessimist");
        expect(config.channels["exceptions"]!.options).toEqual({ report: "all", errorCause: true });
    });

    it("rejects an unknown channel and an invalid dispatch", () => {
        expect(() => configFromObject({ bogus: {} }, ROOT)).toThrow(/unknown channel "bogus"/);
        expect(() => configFromObject({ exceptions: { dispatch: "eager" } }, ROOT)).toThrow(/dispatch must be "optimist" or "pessimist"/);
    });

    it("keeps async fanOut a boolean and rejects the legacy off/warn/error strings", () => {
        expect(configFromObject({ async: { fanOut: true } }, ROOT).channels["async"]!.options).toEqual({ fanOut: true });
        expect(() => configFromObject({ async: { fanOut: "warn" } }, ROOT)).toThrow(/fanOut must be a boolean/);
    });
});

describe("kernel config — legacy key rejection", () => {
    const CASES: ReadonlyArray<[string, unknown, RegExp]> = [
        ["presets", ["node"], /platform models are built in/],
        ["overlays", ["x.jsonc"], /platform models are built in/],
        ["channels", { exceptions: {} }, /"channels" wrapper removed/],
        ["severity", "error", /moved into each channel/],
        ["failOnFindings", true, /moved into each channel/],
        ["sinks", [], /always whole-project/],
        ["handlerBoundaries", [], /always whole-project/],
        ["entryPoints", [], /always whole-project/],
    ];

    for (const [key, value, re] of CASES) {
        it(`rejects the removed "${key}" key with a replacement diagnostic`, () => {
            expect(() => configFromObject({ [key]: value }, ROOT)).toThrow(re);
        });
    }

    it('rejects a per-channel "enabled" pointing to severity: off', () => {
        expect(() => configFromObject({ exceptions: { enabled: false } }, ROOT)).toThrow(/enabled/);
    });
});

describe("kernel config — tsconfig discovery and merge", () => {
    it("inherits the tsc-probe key through a package extends entry", () => {
        let dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-config-")),
            pkg = path.join(dir, "node_modules", "shared-config"),
            tsconfig = path.join(dir, "tsconfig.json");

        try {
            fs.mkdirSync(pkg, { recursive: true });
            fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "shared-config" }));
            fs.writeFileSync(path.join(pkg, "tsconfig.json"), JSON.stringify({
                "tsc-probe": { exceptions: { severity: "error", report: "cross-module" } },
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
        let dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-config-")),
            pkg = path.join(dir, "node_modules", "shared-config"),
            tsconfig = path.join(dir, "tsconfig.json");

        try {
            fs.mkdirSync(pkg, { recursive: true });
            fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "shared-config" }));
            fs.writeFileSync(path.join(pkg, "tsconfig.json"), JSON.stringify({
                "tsc-probe": {
                    exceptions: { severity: "error", report: "cross-module", errorCause: true },
                    resources: { severity: "error" },
                },
            }));
            fs.writeFileSync(tsconfig, JSON.stringify({
                extends: "shared-config/tsconfig.json",
                "tsc-probe": { exceptions: { report: "consumers" }, resources: null },
            }));

            let config = loadConfigFromTsconfig(tsconfig);

            // The child overrides only `report`; the base's other keys survive.
            expect(config?.channels["exceptions"]!.options).toEqual({ report: "consumers", errorCause: true });
            // `null` deletes the inherited `resources` channel, so it is off.
            expect(config?.channels["resources"]!.severity).toBe("off");
        }
        finally {
            fs.rmSync(dir, { force: true, recursive: true });
        }
    });
});
