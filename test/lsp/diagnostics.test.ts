import { describe, expect, it } from "vitest";

import { TextDocument } from "vscode-languageserver-textdocument";

import { codeActionsAt, hoverAt } from "~/lsp/diagnostics";
import type { Diagnostic } from "~/probe/kernel/types";

const URI = "file:///x.ts";

function doc(text: string): TextDocument {
    return TextDocument.create(URI, "typescript", 1, text);
}

function diag(pos: number, end: number, extra?: Partial<Diagnostic>): Diagnostic {
    return {
        channel: "async",
        location: { column: 1, end, fileName: "/x.ts", line: 1, pos },
        message: "orphan promise",
        related: [],
        ...extra,
    };
}

describe("lsp diagnostics — hover", () => {
    it("returns the finding covering an offset, with its message", () => {
        const hover = hoverAt([diag(0, 5)], 2, doc("foo();\n"));
        expect(hover).toBeDefined();
        expect((hover!.contents as { value: string }).value).toContain("orphan promise");
        expect((hover!.contents as { value: string }).value).toContain("async");
    });

    it("returns undefined off any finding", () => {
        expect(hoverAt([diag(0, 5)], 10, doc("foo();\n"))).toBeUndefined();
    });
});

describe("lsp diagnostics — code actions", () => {
    it("maps a channel fix to a quick-fix with the document-mapped edit", () => {
        const fixes = [{ edits: [{ end: 0, fileName: "/x.ts", newText: "void ", pos: 0 }], title: "Ignore the result with `void`" }];
        const actions = codeActionsAt([diag(0, 5, { fixes })], 0, 5, doc("foo();\n"), () => URI);

        expect(actions).toHaveLength(1);
        expect(actions[0]!.title).toContain("void");

        const edit = actions[0]!.edit!.changes![URI]![0]!;
        expect(edit.newText).toBe("void ");
        expect(edit.range.start).toEqual({ character: 0, line: 0 });
    });

    it("returns nothing for a range that misses every finding", () => {
        const fixes = [{ edits: [{ end: 0, fileName: "/x.ts", newText: "void ", pos: 0 }], title: "void" }];
        expect(codeActionsAt([diag(0, 5, { fixes })], 8, 9, doc("foo();\nbar();\n"), () => URI)).toHaveLength(0);
    });
});
