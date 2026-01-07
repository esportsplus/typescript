import ts from 'typescript';


const getExpressionName = (node: ts.Expression): string | null => {
    if (ts.isIdentifier(node)) {
        return node.text;
    }

    if (ts.isPropertyAccessExpression(node)) {
        return getPropertyPath(node);
    }

    return null;
};

const getPropertyPath = (node: ts.Expression): string | null => {
    let current: ts.Node = node,
        parts: string[] = [];

    while (ts.isPropertyAccessExpression(current)) {
        parts.push(current.name.text);
        current = current.expression;
    }

    if (ts.isIdentifier(current)) {
        parts.push(current.text);
        return parts.reverse().join('.');
    }

    return null;
};


export { getExpressionName, getPropertyPath };
