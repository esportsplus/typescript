import type { Range } from './types';
import type { Expression, Node } from 'typescript/unstable/ast';
import { isIdentifier, isPropertyAccessExpression } from 'typescript/unstable/ast/is';


const expression = {
    name: (node: Expression): string | null => {
        if (isIdentifier(node)) {
            return node.text;
        }

        if (isPropertyAccessExpression(node)) {
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
    path: (node: Expression): string | null => {
        let current: Node = node,
            parts: string[] = [];

        while (isPropertyAccessExpression(current)) {
            parts.push(current.name.text);
            current = current.expression;
        }

        if (isIdentifier(current)) {
            parts.push(current.text);
            return parts.reverse().join('.');
        }

        return null;
    }
};

const test = (node: Node, fn: (n: Node) => boolean): boolean => {
    if (fn(node)) {
        return true;
    }

    return !!node.forEachChild(child => test(child, fn) || undefined);
};


export default { expression, inRange, property, test };
export type { Range };
