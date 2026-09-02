import * as ts from '~/probe/adapter';

import type { FunctionLike } from './types';

type UnwrapOptions = {
    assertions?: boolean;
    awaits?: boolean;
};

function shouldUnwrap(expr: ts.Expression, options: UnwrapOptions): boolean {
    return (
        ts.isParenthesizedExpression(expr) ||
        (options.assertions === true &&
            (ts.isAsExpression(expr) || ts.isNonNullExpression(expr))) ||
        (options.awaits === true && ts.isAwaitExpression(expr))
    );
}

const bodyOf = (node: FunctionLike): ts.Node | undefined => {
    return (node as { body?: ts.Node }).body;
};

const calleeSelectors = (callee: ts.Expression): Set<string> => {
    let selectors = new Set<string>();

    if (ts.isIdentifier(callee)) {
        selectors.add(callee.text);
    } else if (ts.isPropertyAccessExpression(callee)) {
        let member = callee.name.text;

        selectors.add(member);

        if (ts.isIdentifier(callee.expression)) {
            selectors.add(`${callee.expression.text}.${member}`);
            selectors.add(`${callee.expression.text}#${member}`);
        }
    }

    return selectors;
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
        ).expression;
    }

    return unwrapped;
};

export { bodyOf, calleeSelectors, paramSymbols, unwrap };
