import { afterEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

import { AnalyzeWorkspace } from "~/lsp/workspace";
import { createFixtureDir } from "../cli/fixtures";

const TSCONFIG = {
    compilerOptions: { lib: ["esnext"], module: "esnext", moduleResolution: "bundler", noEmit: true, skipLibCheck: true, strict: true, target: "esnext", types: [] as string[] },
    include: ["src"],
};

let dir: string | undefined;
let workspace: AnalyzeWorkspace | undefined;

afterEach(() => {
    workspace?.dispose();
    workspace = undefined;

    if (dir) {
        fs.rmSync(dir, { force: true, recursive: true });
        dir = undefined;
    }
});

function project(probe: Record<string, unknown>): string {
    dir = createFixtureDir(".fixture-ws-");
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ ...TSCONFIG, "tsc-probe": probe }));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export function b(): void {}\n");

    return path.join(dir, "tsconfig.json");
}

describe("lsp workspace — config error surfacing", () => {
    it("keeps config undefined and records configError on a rejected legacy key", () => {
        workspace = new AnalyzeWorkspace(project({ channels: { exceptions: {} } }));

        expect(workspace.config).toBeUndefined();
        expect(workspace.configError).toMatch(/"channels" wrapper removed/);
    });

    it("loads a clean config with no configError", () => {
        workspace = new AnalyzeWorkspace(project({ exceptions: { severity: "error" } }));

        expect(workspace.config).toBeDefined();
        expect(workspace.configError).toBeUndefined();
        expect(workspace.config!.channels["exceptions"]!.severity).toBe("error");
    });
});
