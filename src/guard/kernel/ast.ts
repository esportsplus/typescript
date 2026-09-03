import * as ts from '~/guard/adapter';

import type { FunctionLike } from './types';

type UnwrapOptions = {
    assertions?: boolean;
    awaits?: boolean;
};

function shouldUnwrap(expr: ts.Expression, options: UnwrapOptions): boolean {
    return (
        ts.isParenthesizedExpression(expr) ||
        (options.assertions === true &&
            (ts.isAsExpression(expr) ||
                ts.isNonNullExpression(expr) ||
                ts.isSatisfiesExpression(expr))) ||
        (options.awaits === true && ts.isAwaitExpression(expr))
    );
}

const bodyOf = (node: ts.Node): ts.Node | undefined => {
    return (node as { body?: ts.Node }).body;
};

const constituents = (type: ts.Type): ReadonlyArray<ts.Type> => {
    return ts.unionTypes(type) ?? [type];
};

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => {
    const modifiers = (
        node as { modifiers?: ReadonlyArray<{ kind: ts.SyntaxKind }> }
    ).modifiers;
    return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
};

const isAwaited = (call: ts.CallExpression): boolean => {
    let child: ts.Node = call;
    let parent = call.parent;

    while (
        parent &&
        (ts.isParenthesizedExpression(parent) ||
            ts.isAsExpression(parent) ||
            ts.isNonNullExpression(parent)) &&
        (parent as { expression?: ts.Node }).expression === child
    ) {
        child = parent;
        parent = parent.parent;
    }

    return parent !== undefined && ts.isAwaitExpression(parent);
};

const paramSymbols = (
    checker: ts.TypeChecker,
    fn: FunctionLike,
): Map<ts.Symbol, number> => {
    let symbols = new Map<ts.Symbol, number>();
    let params = (fn as { parameters?: ts.NodeArray<ts.ParameterDeclaration> })
        .parameters;

    if (params) {
        params.forEach((param, index) => {
            if (ts.isIdentifier(param.name)) {
                let symbol = checker.getSymbolAtLocation(param.name);

                if (symbol) {
                    symbols.set(symbol, index);
                }
            }
        });
    }

    return symbols;
};

const unwrap = (
    expr: ts.Expression,
    options: UnwrapOptions = {},
): ts.Expression => {
    let unwrapped = expr;

    while (shouldUnwrap(unwrapped, options)) {
        unwrapped = (
            unwrapped as
                | ts.AsExpression
                | ts.AwaitExpression
                | ts.NonNullExpression
                | ts.ParenthesizedExpression
                | ts.SatisfiesExpression
        ).expression;
    }

    return unwrapped;
};

export { bodyOf, constituents, hasModifier, isAwaited, paramSymbols, unwrap };
