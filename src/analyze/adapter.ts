// Adapter that presents the native TypeScript 7 `unstable` modules under the
// classic `ts.*` surface analyze was written against. analyze files import this
// as `import * as ts from "~/analyze/adapter"`.
export * from 'typescript/unstable/ast';
export * from 'typescript/unstable/ast/is';
export * from 'typescript/unstable/sync';
// ModifierFlags is exported by both ast and sync; pick one to resolve the star.
export { ModifierFlags } from 'typescript/unstable/sync';

import { SyntaxKind, type Node, type SourceFile } from 'typescript/unstable/ast';
import { TypeFlags, type Checker, type Program, type Symbol, type Type, type UnionType } from 'typescript/unstable/sync';

// Classic name for the checker.
export type TypeChecker = Checker;

// Classic `ts.forEachChild(node, cb)` → the node method on the native AST.
export function forEachChild<T>(node: Node, cb: (child: Node) => T | undefined): T | undefined {
    return (node as { forEachChild(cb: (child: Node) => T | undefined): T | undefined }).forEachChild(cb);
}

// `isClassLike` is not in ast/is; classes are exactly these two kinds.
export function isClassLike(node: Node): boolean {
    return node.kind === SyntaxKind.ClassDeclaration || node.kind === SyntaxKind.ClassExpression;
}

// Native `Program` exposes file names, not materialized SourceFiles; materialize.
export function getSourceFiles(program: Program): SourceFile[] {
    const out: SourceFile[] = [];
    for (const name of program.getSourceFileNames()) {
        const sf = program.getSourceFile(name);
        if (sf) {
            out.push(sf);
        }
    }
    return out;
}

// Native symbol declarations are lightweight `NodeHandle`s; resolve to nodes.
export function symbolDeclarations(symbol: Symbol): Node[] {
    const out: Node[] = [];
    for (const handle of symbol.declarations ?? []) {
        const node = handle.resolve();
        if (node) {
            out.push(node);
        }
    }
    return out;
}

export function symbolValueDeclaration(symbol: Symbol): Node | undefined {
    return symbol.valueDeclaration?.resolve();
}

// Union constituents, or undefined for a non-union type.
export function unionTypes(type: Type): readonly Type[] | undefined {
    return (type.flags & TypeFlags.Union) !== 0 ? (type as UnionType).getTypes() : undefined;
}
