import { describe, expect, it } from "vitest";

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configFromObject, loadConfigFromTsconfig, parseConfig } from "~/probe/kernel/config";
import { stripJsonc } from '~/jsonc';

let ROOT = "/project";

describe("kernel config — JSONC parsing", () => {
    it("strips line and block comments but preserves comment-like text inside strings", () => {
        let text = `{
    // a line comment
    "tsconfig": "tsconfig.json", /* trailing block */
    "channels": {
        "exceptions": { "enabled": true }
    },
    "entryPoints": ["http://not-a-comment", "a/*still*/b"]
}`;
        let config = parseConfig(text, ROOT);
        expect(config.entryPoints).toEqual(["http://not-a-comment", "a/*still*/b"]);
        expect(config.channels["exceptions"]!.enabled).toBe(true);
    });

    it("removes trailing commas before object and array closers", () => {
        let text = `{
    "entryPoints": ["src/**/*.ts",],
    "channels": { "async": { "enabled": true, }, },
}`;
        let config = parseConfig(text, ROOT);
        expect(config.entryPoints).toEqual(["src/**/*.ts"]);
        expect(config.channels["async"]!.enabled).toBe(true);
    });

    it('preserves comma-like text inside strings while stripping trailing commas', () => {
        let config = JSON.parse(stripJsonc('{"a":"x,]","b":[1,],}'));

        expect(config).toEqual({ a: 'x,]', b: [1] });
    });

    it("throws a prefixed error on invalid JSONC", () => {
        expect(() => parseConfig("{ not json", ROOT)).toThrow(/analyze config: invalid JSONC/);
    });
});

describe("kernel config — validation and defaults", () => {
    it("defaults channel enablement: exceptions on, resources/async off", () => {
        let config = configFromObject({}, ROOT);
        expect(config.channels["exceptions"]!.enabled).toBe(true);
        expect(config.channels["resources"]!.enabled).toBe(false);
        expect(config.channels["async"]!.enabled).toBe(false);
    });

    it("folds unknown channel keys into a loud failure", () => {
        expect(() => configFromObject({ channels: { bogus: { enabled: true } } }, ROOT)).toThrow(
            /unknown channel "bogus"/,
        );
    });

    it("rejects a non-boolean enabled and an invalid dispatch", () => {
        expect(() => configFromObject({ channels: { exceptions: { enabled: "yes" } } }, ROOT)).toThrow(
            /channels.exceptions.enabled must be a boolean/,
        );
        expect(() => configFromObject({ channels: { exceptions: { dispatch: "eager" } } }, ROOT)).toThrow(
            /dispatch must be "optimist" or "pessimist"/,
        );
    });

    it("collects non-enabled/dispatch keys as opaque channel options", () => {
        let config = configFromObject(
            { channels: { exceptions: { enabled: true, dispatch: "pessimist", report: "all", errorCause: true } } },
            ROOT,
        );
        let exceptions = config.channels["exceptions"]!;
        expect(exceptions.dispatch).toBe("pessimist");
        expect(exceptions.options).toEqual({ report: "all", errorCause: true });
    });

    it("parses sinks and rejects a malformed sink", () => {
        let config = configFromObject({ sinks: [{ callee: "guard", absorbs: ["TypeError"] }] }, ROOT);
        expect(config.sinks).toEqual([{ callee: "guard", absorbs: ["TypeError"] }]);
        expect(() => configFromObject({ sinks: [{ absorbs: [] }] }, ROOT)).toThrow(/sinks\[0\].callee/);
    });

    it("reads the failOnFindings gate only for a literal true", () => {
        expect(configFromObject({ failOnFindings: true }, ROOT).failOnFindings).toBe(true);
        expect(configFromObject({ failOnFindings: "true" }, ROOT).failOnFindings).toBe(false);
        expect(configFromObject({}, ROOT).failOnFindings).toBe(false);
    });
});


describe('kernel config — tsconfig plugin discovery', () => {
    it('finds ts-probe inherited through a package extends entry', () => {
        let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-config-')),
            pkg = path.join(dir, 'node_modules', 'shared-config'),
            tsconfig = path.join(dir, 'tsconfig.json');

        try {
            fs.mkdirSync(pkg, { recursive: true });
            fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'shared-config' }));
            fs.writeFileSync(path.join(pkg, 'tsconfig.json'), JSON.stringify({
                compilerOptions: { plugins: [{ name: 'ts-probe', entryPoints: ['src/**/*.ts'] }] },
            }));
            fs.writeFileSync(tsconfig, JSON.stringify({ extends: 'shared-config/tsconfig.json' }));

            expect(loadConfigFromTsconfig(tsconfig)?.entryPoints).toEqual(['src/**/*.ts']);
        }
        finally {
            fs.rmSync(dir, { force: true, recursive: true });
        }
    });
});
