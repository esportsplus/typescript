import { describe, expect, it } from "vitest";

import { configFromObject, parseConfig } from "~/probe/kernel/config";

const ROOT = "/project";

describe("kernel config — JSONC parsing", () => {
    it("strips line and block comments but preserves comment-like text inside strings", () => {
        const text = `{
    // a line comment
    "tsconfig": "tsconfig.json", /* trailing block */
    "channels": {
        "exceptions": { "enabled": true }
    },
    "entryPoints": ["http://not-a-comment", "a/*still*/b"]
}`;
        const config = parseConfig(text, ROOT);
        expect(config.entryPoints).toEqual(["http://not-a-comment", "a/*still*/b"]);
        expect(config.channels["exceptions"]!.enabled).toBe(true);
    });

    it("removes trailing commas before object and array closers", () => {
        const text = `{
    "entryPoints": ["src/**/*.ts",],
    "channels": { "async": { "enabled": true, }, },
}`;
        const config = parseConfig(text, ROOT);
        expect(config.entryPoints).toEqual(["src/**/*.ts"]);
        expect(config.channels["async"]!.enabled).toBe(true);
    });

    it("throws a prefixed error on invalid JSONC", () => {
        expect(() => parseConfig("{ not json", ROOT)).toThrow(/analyze config: invalid JSONC/);
    });
});

describe("kernel config — validation and defaults", () => {
    it("defaults channel enablement: exceptions on, resources/async off", () => {
        const config = configFromObject({}, ROOT);
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
        const config = configFromObject(
            { channels: { exceptions: { enabled: true, dispatch: "pessimist", report: "all", errorCause: true } } },
            ROOT,
        );
        const exceptions = config.channels["exceptions"]!;
        expect(exceptions.dispatch).toBe("pessimist");
        expect(exceptions.options).toEqual({ report: "all", errorCause: true });
    });

    it("parses sinks and rejects a malformed sink", () => {
        const config = configFromObject({ sinks: [{ callee: "guard", absorbs: ["TypeError"] }] }, ROOT);
        expect(config.sinks).toEqual([{ callee: "guard", absorbs: ["TypeError"] }]);
        expect(() => configFromObject({ sinks: [{ absorbs: [] }] }, ROOT)).toThrow(/sinks\[0\].callee/);
    });

    it("reads the failOnFindings gate only for a literal true", () => {
        expect(configFromObject({ failOnFindings: true }, ROOT).failOnFindings).toBe(true);
        expect(configFromObject({ failOnFindings: "true" }, ROOT).failOnFindings).toBe(false);
        expect(configFromObject({}, ROOT).failOnFindings).toBe(false);
    });
});
