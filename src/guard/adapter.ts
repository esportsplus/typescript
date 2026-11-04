// Adapter that presents the native TypeScript 7 `unstable` modules under the
// classic `ts.*` surface analyze was written against. analyze files import this
// as a namespace (`import * as ts from '../adapter'`).
export * from 'typescript/ast';
export * from 'typescript/ast/is';
export * from 'typescript/sync';
// ModifierFlags is exported by both ast and sync; pick one to resolve the star.
export { ModifierFlags } from 'typescript/sync';

import {
    type Node,
    type SourceFile,
    SyntaxKind,
} from 'typescript/ast';
import {
    type Checker,
    type Program,
    type Symbol,
    type Type,
    TypeFlags,
    type UnionType,
} from 'typescript/sync';

import checkers from '../compiler/checker';

// Classic name for the checker.
export type TypeChecker = Checker;

// Classic `ts.forEachChild(node, cb)` → the node method on the native AST.
function forEachChild<T>(
    node: Node,
    cb: (child: Node) => T | undefined,
): T | undefined {
    return (
        node as {
            forEachChild(cb: (child: Node) => T | undefined): T | undefined;
        }
    ).forEachChild(cb);
}

// `isClassLike` is not in ast/is; classes are exactly these two kinds.
function isClassLike(node: Node): boolean {
    return (
        node.kind === SyntaxKind.ClassDeclaration ||
        node.kind === SyntaxKind.ClassExpression
    );
}

// The program's in-project, non-declaration files (the native Program does not
// expose the tsconfig root set). It exposes file names, not SourceFiles, and
// materializing one costs its transfer, so names that cannot be an entry are
// dropped first and the rest fetched together; `isDeclarationFile` still decides
// for them (`x.d.css.ts`).
function getEntrySourceFiles(program: Program): SourceFile[] {
    const names: [string][] = [];
    for (const name of program.getSourceFileNames()) {
        if (
            /\.d\.[cm]?ts$/.test(name) ||
            name.replace(/\\/g, '/').includes('/node_modules/')
        ) {
            continue;
        }
        names.push([name]);
    }
    const out: SourceFile[] = [];
    for (const sf of checkers.batch(program, 'getSourceFile', names)) {
        if (sf && !sf.isDeclarationFile) {
            out.push(sf);
        }
    }
    return out;
}

// Native symbol declarations are lightweight `NodeHandle`s; resolve to nodes.
function symbolDeclarations(symbol: Symbol): Node[] {
    const out: Node[] = [];
    for (const handle of symbol.declarations ?? []) {
        const node = handle.resolve();
        if (node) {
            out.push(node);
        }
    }
    return out;
}

// Union constituents, or undefined for a non-union type.
function unionTypes(type: Type): readonly Type[] | undefined {
    return (type.flags & TypeFlags.Union) !== 0
        ? (type as UnionType).getTypes()
        : undefined;
}


export { forEachChild, getEntrySourceFiles, isClassLike, symbolDeclarations, unionTypes };
