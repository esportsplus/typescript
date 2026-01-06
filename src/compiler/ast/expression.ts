import { ts } from '../..';


const getExpressionName = (node: ts.Expression): string | null => {
    if (ts.isIdentifier(node)) {
        return node.text;
    }

    if (ts.isPropertyAccessExpression(node)) {
        return getPropertyPathString(node);
    }

    return null;
}

const getPropertyPath = (node: ts.Expression): string[] | null => {
    let current: ts.Node = node,
        parts: string[] = [];

    while (ts.isPropertyAccessExpression(current)) {
        parts.push(current.name.text);
        current = current.expression;
    }

    if (ts.isIdentifier(current)) {
        parts.push(current.text);
        return parts.reverse();
    }

    return null;
}

const getPropertyPathString = (node: ts.Expression): string | null => {
    let parts = getPropertyPath(node);

    return parts ? parts.join('.') : null;
}

const unwrapParentheses = (expr: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expr)) {
        expr = expr.expression;
    }

    return expr;
}


export { getExpressionName, getPropertyPath, getPropertyPathString, unwrapParentheses };
