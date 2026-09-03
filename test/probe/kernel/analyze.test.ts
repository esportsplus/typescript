import { describe, expect, it } from "vitest";

import { analyzeFixture } from "../harness";

describe("analyze — silent peer channels", () => {
    it("runs an off dependency's transfer for its summaries but discards its diagnostics", () => {
        const sources = {
            "index.ts": [
                "export function boom() {",
                "    throw new Error('x');",
                "}",
                "export function leaks() {",
                "    const h = setInterval(() => {}, 1000);",
                "    boom();",
                "    clearInterval(h);",
                "}",
            ].join("\n"),
        };

        // resources is enabled and `dependsOn` exceptions; exceptions itself is
        // OFF. B6: exceptions still runs (so its throw summaries exist and resources
        // sees `boom` throw past the release), but its own diagnostics are dropped.
        const diags = analyzeFixture(sources, {
            channels: {
                exceptions: { enabled: false },
                resources: { dispatch: "pessimist", enabled: true },
            },
        });

        expect(diags.some((d) => d.channel === "exceptions")).toBe(false);
        expect(diags.some((d) => d.channel === "resources" && /leak/.test(d.message))).toBe(true);
    });

    it("analyzes nothing when every channel is off", () => {
        const diags = analyzeFixture(
            { "index.ts": "export function b(x: string): unknown { return JSON.parse(x); }\n" },
            { channels: { exceptions: { enabled: false } } },
        );

        expect(diags).toHaveLength(0);
    });
});
