import ts from 'typescript';


type Range = {
    end: number;
    start: number;
};


const expression = {
    name: (node: ts.Expression): string | null => {
        if (ts.isIdentifier(node)) {
            return node.text;
        }

        if (ts.isPropertyAccessExpression(node)) {
            return property.path(node);
        }

        return null;
    }
};

const inRange = (ranges: Range[], start: number, end: number): boolean => {
    for (let i = 0, n = ranges.length; i < n; i++) {
        let r = ranges[i];

        if (start >= r.start && end <= r.end) {
            return true;
        }
    }

    return false;
};

const property = {
    path: (node: ts.Expression): string | null => {
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
    }
};

const test = (node: ts.Node, fn: (n: ts.Node) => boolean): boolean => {
    if (fn(node)) {
        return true;
    }

    return !!ts.forEachChild(node, child => test(child, fn) || undefined);
};


export default { expression, inRange, property, test };
export type { Range };
