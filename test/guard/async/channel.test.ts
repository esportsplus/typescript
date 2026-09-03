import { describe, expect, it } from "vitest";

import { analyzeFixture } from '../harness';
import fs from 'node:fs';
import path from 'node:path';
import type { Diagnostic } from "~/guard/kernel/types";


let fixtureDir = path.join(import.meta.dirname, 'fixtures');

let sources = Object.fromEntries(
    fs.readdirSync(fixtureDir)
        .filter((file) => file.endsWith('.ts'))
        .map((file) => [file, fs.readFileSync(path.join(fixtureDir, file), 'utf8')])
);


function inFile(diags: ReadonlyArray<Diagnostic>, file: string): ReadonlyArray<Diagnostic> {
    return diags.filter((diagnostic) => diagnostic.location.fileName.replace(/\\/g, '/').endsWith(`/${file}`));
}


function runAsync(): ReadonlyArray<Diagnostic> {
    return analyzeFixture(sources, {
        channels: {
            async: { enabled: true },
            exceptions: { enabled: false }
        }
    }).filter((diagnostic) => diagnostic.channel === 'async');
}

function messages(diags: ReadonlyArray<Diagnostic>): string[] {
    return diags.map((d) => d.message);
}

function fanOutOf(): ReadonlyArray<Diagnostic> {
    return inFile(runAsync(), "fanout.ts").filter((d) => d.message.startsWith("unbounded fan-out"));
}

describe("async channel — A1 bounded fan-out", () => {
    it("does not flag a statically-sized array literal but flags dynamic map aggregations", () => {
        // boundedOk's literal is statically sized (fine); dynamicBad and pooledOk are
        // both dynamically-sized `.map` inputs, so both flag.
        const diags = fanOutOf();
        expect(diags.length).toBe(2);
        expect(diags.every((d) => d.message.includes("unbounded fan-out"))).toBe(true);
        expect(diags.every((d) => d.message.includes("Promise.all"))).toBe(true);
    });
});

describe("async channel — A2 promise ownership", () => {
    function ownership(): ReadonlyArray<Diagnostic> {
        return inFile(runAsync(), "ownership.ts");
    }

    it("flags an orphan in statement position", () => {
        const diags = ownership();
        const orphans = diags.filter((d) => d.message.includes("syncUsers"));
        expect(orphans.some((d) => d.message.includes("neither awaited nor voided"))).toBe(true);
    });

    it("does not flag awaited, voided, returned, or rejection-handled promises", () => {
        const diags = ownership();
        const lines = new Set(diags.map((d) => d.location.line));
        // droppedStatement + danglingThen are the only orphans; everything else clean.
        expect(diags.length).toBe(2);
        expect(messages(diags).every((m) => m.includes("syncUsers"))).toBe(true);
        // No diagnostic for the non-promise call.
        expect(lines.size).toBe(2);
    });

    it("flags a dangling .then with no rejection handler but not a .catch chain", () => {
        const diags = ownership();
        // Exactly two orphans: droppedStatement and danglingThen.
        expect(diags.length).toBe(2);
    });

    it("offers a `void` quick-fix on an orphan", () => {
        const orphan = ownership().find((d) => d.message.includes("syncUsers"));
        const fix = orphan?.fixes?.find((f) => f.title.includes("void"));
        expect(fix).toBeDefined();
        expect(fix!.edits[0]!.newText).toBe("void ");
    });

    it("flags an orphan whose return is ignored across a call boundary", () => {
        const diags = inFile(runAsync(), "cross_b.ts");
        expect(diags.length).toBe(1);
        expect(diags[0]!.message).toContain("remoteSync");
        expect(diags[0]!.message).toContain("neither awaited nor voided");
    });
});

describe("async channel — A3 cancellation", () => {
    function cancellation(): ReadonlyArray<Diagnostic> {
        return inFile(runAsync(), "cancellation.ts");
    }

    it("flags dropped signals: overlay-cancellable and app-wrapper inheritance", () => {
        // drops + destructuredDrops (fetch) + wrapperDrops (an app fn that itself
        // takes a signal); forwards/destructuredForwards/wrapperForwards pass it,
        // neverHadSignal holds none.
        const diags = cancellation();
        expect(diags.length).toBe(3);
        expect(diags.every((d) => d.message.includes("cannot be cancelled"))).toBe(true);
    });

    it("offers a forward-signal quick-fix for overlay-cancellable calls only", () => {
        const withFix = cancellation().filter((d) => d.fixes?.some((f) => f.title.includes("Forward the AbortSignal")));
        // The two fetch drops get a `{ signal }` fix; the app-wrapper drop does not.
        expect(withFix.length).toBe(2);
        expect(withFix[0]!.fixes!.find((f) => f.title.includes("Forward"))!.edits[0]!.newText).toContain("signal");
    });
});
