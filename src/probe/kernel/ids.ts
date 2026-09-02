import * as ts from '~/probe/adapter';

import type { FunctionInfo, FunctionLike, SourceLocation } from './types';

const FUNCTION_LIKE_KINDS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.Constructor,
]);

// Narrow any node to the FunctionLike union the kernel treats as a graph node.
function isFunctionLike(node: ts.Node): node is FunctionLike {
    return FUNCTION_LIKE_KINDS.has(node.kind);
}

// Best-effort display name for a function-like node.
function functionName(node: FunctionLike): string {
    if (ts.isConstructorDeclaration(node)) {
        const cls = node.parent as { name?: ts.Identifier };
        const clsName =
            ts.isClassLike(node.parent) && cls.name
                ? cls.name.text
                : '<anonymous>';
        return `${clsName}.constructor`;
    }
    const named = node as { name?: ts.Node };
    if (named.name && ts.isIdentifier(named.name)) {
        return named.name.text;
    }
    if (
        (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)
    ) {
        return node.parent.name.text;
    }
    if (
        (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
        ts.isPropertyAssignment(node.parent) &&
        ts.isIdentifier(node.parent.name)
    ) {
        return node.parent.name.text;
    }
    return '<anonymous>';
}

// Stable per-run identity: file path + node start. Two runs over the same tree
// produce the same id, and no two nodes in a file share a start position.
function functionId(
    node: FunctionLike,
    sourceFile: ts.SourceFile,
): string {
    return `${sourceFile.fileName}:${node.getStart(sourceFile)}`;
}

function makeFunctionInfo(
    node: FunctionLike,
    sourceFile: ts.SourceFile,
): FunctionInfo {
    const nameNode = (node as { name?: ts.Node }).name;
    const pos = nameNode
        ? nameNode.getStart(sourceFile)
        : node.getStart(sourceFile);
    return {
        id: functionId(node, sourceFile),
        node,
        sourceFile,
        name: functionName(node),
        fileName: sourceFile.fileName,
        pos,
    };
}

function locationOf(
    node: ts.Node,
    sourceFile: ts.SourceFile,
): SourceLocation {
    const start = node.getStart(sourceFile);
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
    return {
        fileName: sourceFile.fileName,
        line: line + 1,
        column: character + 1,
        pos: start,
        end: node.getEnd(),
    };
}


export { functionId, functionName, isFunctionLike, locationOf, makeFunctionInfo };
