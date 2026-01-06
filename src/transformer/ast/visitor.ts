import ts from 'typescript';


const hasMatch = (node: ts.Node, predicate: (n: ts.Node) => boolean): boolean => {
    if (predicate(node)) {
        return true;
    }

    return !!ts.forEachChild(node, child => hasMatch(child, predicate) || undefined);
};


export { hasMatch };