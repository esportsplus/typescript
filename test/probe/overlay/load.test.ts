import { describe, expect, it } from "vitest";

import { mergeOverlayData, overlayKey } from "~/probe/overlay/load";

describe("overlay key format", () => {
    it("renders a bare global, a namespace member, and an interface method", () => {
        expect(overlayKey(undefined, "parseInt", false)).toBe("parseInt");
        expect(overlayKey("JSON", "parse", true)).toBe("JSON.parse");
        expect(overlayKey("Array", "map", false)).toBe("Array#map");
    });
});

describe("overlay merge", () => {
    it("treats a bare file as the exceptions section and a bundle as channel-keyed", () => {
        const merged = mergeOverlayData([
            { name: "bare", text: JSON.stringify({ "lib.es5": { "JSON.parse": { exceptions: ["SyntaxError"] } } }) },
            {
                name: "bundle",
                text: JSON.stringify({
                    overlay: { async: { "lib.dom": { fetch: { cancellable: true } } } },
                    handlerBoundaries: [{ callee: "app.get", callbackArgs: [1] }],
                }),
            },
        ]);
        expect(merged.entry("exceptions", "lib.es5", "JSON.parse")).toEqual({ exceptions: ["SyntaxError"] });
        expect(merged.entry("async", "lib.dom", "fetch")).toEqual({ cancellable: true });
        expect(merged.boundaries).toEqual([{ callee: "app.get", callbackArgs: [1] }]);
    });

    it("lets a later file win on a colliding key", () => {
        const merged = mergeOverlayData([
            { name: "first", text: JSON.stringify({ "lib.es5": { "JSON.parse": { exceptions: ["SyntaxError"] } } }) },
            { name: "second", text: JSON.stringify({ "lib.es5": { "JSON.parse": { exceptions: [] } } }) },
        ]);
        expect(merged.entry("exceptions", "lib.es5", "JSON.parse")).toEqual({ exceptions: [] });
    });

    it("merges sections across files without dropping earlier keys", () => {
        const merged = mergeOverlayData([
            { name: "a", text: JSON.stringify({ "lib.es5": { RegExp: { exceptions: ["SyntaxError"] } } }) },
            { name: "b", text: JSON.stringify({ "lib.es5": { decodeURI: { exceptions: ["URIError"] } } }) },
        ]);
        expect(merged.entry("exceptions", "lib.es5", "RegExp")).toEqual({ exceptions: ["SyntaxError"] });
        expect(merged.entry("exceptions", "lib.es5", "decodeURI")).toEqual({ exceptions: ["URIError"] });
    });

    it("rejects a non-array handlerBoundaries in a bundle", () => {
        expect(() =>
            mergeOverlayData([{ name: "bad", text: JSON.stringify({ handlerBoundaries: {} }) }]),
        ).toThrow(/handlerBoundaries must be an array/);
    });
});
