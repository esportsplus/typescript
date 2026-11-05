import { constituents, hasModifier } from '../kernel/ast';
import { isFunctionLike } from '../kernel/ids';
import type { FunctionLike } from '../kernel/types';

import * as ts from '../adapter';
import checkers from '../checker';


// Answers fixed for the program snapshot: per type id whether it is a promise, per file whether it
// binds its own `Promise` (which a `Promise<…>` annotation would then name).
type Caches = {
    promiseTypes: Map<number, boolean>;
    shadows: Map<ts.SourceFile, boolean>;
};


// Concise arrow bodies whose type is a primitive, regex or array: none of them carries `then`.
// `null` stays with the checker, it widens to `any` without strictNullChecks.
const LITERAL_KINDS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.ArrayLiteralExpression,
    ts.SyntaxKind.BigIntLiteral,
    ts.SyntaxKind.FalseKeyword,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.TemplateExpression,
    ts.SyntaxKind.TrueKeyword
]);

// Kinds whose type at the declaration is the function's own call signature. Accessors (the type
// there is the property's) and constructors (no call signature) are left to the checker.
const SYNTACTIC_KINDS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.MethodDeclaration
]);

// Return annotations naming a primitive, void or never (a type predicate is boolean, or void when
// it asserts): no `then` either. `any`, `unknown`, `object` and `null` stay with the checker.
const VALUE_ANNOTATION_KINDS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.BigIntKeyword,
    ts.SyntaxKind.BooleanKeyword,
    ts.SyntaxKind.NeverKeyword,
    ts.SyntaxKind.NumberKeyword,
    ts.SyntaxKind.StringKeyword,
    ts.SyntaxKind.SymbolKeyword,
    ts.SyntaxKind.TypePredicate,
    ts.SyntaxKind.UndefinedKeyword,
    ts.SyntaxKind.VoidKeyword
]);


function declaresPromise(sf: ts.SourceFile, shadows: Map<ts.SourceFile, boolean>): boolean {
    let found = shadows.get(sf);

    if (found !== undefined) {
        return found;
    }

    found = false;

    let visit = (node: ts.Node): void => {
        if (found) {
            return;
        }

        if (
            ts.isIdentifier(node) &&
            node.text === 'Promise' &&
            (node.parent as { name?: ts.Node } | undefined)?.name === node &&
            !ts.isPropertyAccessExpression(node.parent)
        ) {
            found = true;
            return;
        }

        ts.forEachChild(node, visit);
    };

    ts.forEachChild(sf, visit);
    shadows.set(sf, found);

    return found;
}

// A `then` member would make the literal a thenable; a spread or computed name could add one.
function isPlainLiteral(body: ts.Node): boolean {
    let expr = body;

    while (ts.isParenthesizedExpression(expr)) {
        expr = expr.expression;
    }

    if (LITERAL_KINDS.has(expr.kind)) {
        return true;
    }

    if (!ts.isObjectLiteralExpression(expr)) {
        return false;
    }

    for (let i = 0, n = expr.properties.length; i < n; i++) {
        let name = (expr.properties[i] as { name?: ts.Node }).name;

        if (!name || ts.isComputedPropertyName(name) || (name as { text?: string }).text === 'then') {
            return false;
        }
    }

    return true;
}

function isPromiseReference(type: ts.TypeNode): boolean {
    return (
        ts.isTypeReferenceNode(type) &&
        ts.isIdentifier(type.typeName) &&
        type.typeName.text === 'Promise' &&
        type.typeArguments?.length === 1
    );
}

// Nested functions own their returns; `return;` yields nothing.
function returnsValue(body: ts.Node): boolean {
    let found = false;

    let visit = (node: ts.Node): void => {
        if (found || isFunctionLike(node)) {
            return;
        }

        if (ts.isReturnStatement(node) && node.expression) {
            found = true;
            return;
        }

        ts.forEachChild(node, visit);
    };

    ts.forEachChild(body, visit);

    return found;
}

// The checker answers from the symbol's first call signature, which is another declaration's when
// the function is overloaded or its class merges with an interface. A sole declaration rules both
// out. Arrows and function expressions never merge.
function soleDeclaration(checker: ts.TypeChecker, node: FunctionLike): boolean {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        return true;
    }

    let name = (node as { name?: ts.Node }).name;

    if (!name || ts.isComputedPropertyName(name)) {
        return false;
    }

    let symbol = checker.getSymbolAtLocation(name);

    return symbol !== undefined && symbol.declarations.length === 1;
}


const isPromiseType = (checker: ts.TypeChecker, type: ts.Type | undefined, cache: Map<number, boolean>): boolean => {
    if (!type) {
        return false;
    }

    let cached = cache.get(type.id);

    if (cached !== undefined) {
        return cached;
    }

    let parts = constituents(type),
        result = false;

    for (let i = 0, n = parts.length; i < n; i++) {
        let part = parts[i],
            symbol = part.getSymbol() ?? part.getAliasSymbol();

        if (symbol && symbol.name === 'Promise') {
            result = true;
            break;
        }

        if (checker.getPropertyOfType(checker.getApparentType(part) ?? part, 'then')) {
            result = true;
            break;
        }
    }

    cache.set(type.id, result);

    return result;
};

// What `inferredReturnsPromise` would answer, read off the declaration when its syntax decides it;
// undefined when only the checker can tell. Each signature query is a tsgo round-trip, and most
// functions are settled here: an async modifier, a `Promise<…>` or primitive annotation, a block
// body that returns nothing (void), or a concise arrow returning a literal. JavaScript is left to
// the checker because JSDoc can declare the return type. The primitive and literal answers assume
// lib's String, Number, Boolean, Array, … are not augmented with a `then` member.
const declaredReturnsPromise = (checker: ts.TypeChecker, node: FunctionLike, caches: Caches): boolean | undefined => {
    if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
        return true;
    }

    let sf = node.getSourceFile();

    if (
        !SYNTACTIC_KINDS.has(node.kind) ||
        (node as { asteriskToken?: ts.Node }).asteriskToken ||
        /\.[cm]?jsx?$/i.test(sf.fileName)
    ) {
        return undefined;
    }

    let type = (node as { type?: ts.TypeNode }).type;

    if (type) {
        if (VALUE_ANNOTATION_KINDS.has(type.kind)) {
            return soleDeclaration(checker, node) ? false : undefined;
        }

        if (!isPromiseReference(type) || declaresPromise(sf, caches.shadows) || !soleDeclaration(checker, node)) {
            return undefined;
        }

        return true;
    }

    let body = (node as { body?: ts.Node }).body;

    if (!body) {
        return undefined;
    }

    if (ts.isBlock(body)) {
        if (returnsValue(body) || !soleDeclaration(checker, node)) {
            return undefined;
        }

        return false;
    }

    return isPlainLiteral(body) ? false : undefined;
};

// The checker's answer: the return type of the first call signature of the function's type.
const inferredReturnsPromise = (checker: ts.TypeChecker, node: FunctionLike, caches: Caches): boolean => {
    let type = checker.getTypeAtLocation(node);

    if (!type) {
        return false;
    }

    let signature = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];

    if (!signature) {
        return false;
    }

    return isPromiseType(checker, checker.getReturnTypeOfSignature(signature), caches.promiseTypes);
};

// Asks what `isPromiseType` will ask about each type, one step at a time for all of them: the
// apparent type of each constituent up to the first named `Promise`, then its `then` member. The
// memoized checker then answers every later single query.
const prefetchPromiseTypes = (checker: ts.TypeChecker, types: ReadonlyArray<ts.Type | undefined>, cache: Map<number, boolean>): void => {
    let parts: ts.Type[] = [],
        seen = new Set<number>();

    for (let i = 0, n = types.length; i < n; i++) {
        let type = types[i];

        if (!type || cache.has(type.id) || seen.has(type.id)) {
            continue;
        }

        seen.add(type.id);

        for (let part of constituents(type)) {
            let symbol = part.getSymbol() ?? part.getAliasSymbol();

            if (symbol && symbol.name === 'Promise') {
                break;
            }

            parts.push(part);
        }
    }

    if (parts.length === 0) {
        return;
    }

    let apparent = checkers.batch(checker, 'getApparentType', parts.map((part) => [part] as [ts.Type]));

    checkers.batch(checker, 'getPropertyOfType', parts.map((part, i) => [apparent[i] ?? part, 'then'] as [ts.Type, string]));
};

// Asks what `inferredReturnsPromise` will ask about each function whose syntax does not decide it,
// one step at a time for all of them: types, call signatures, then return types, which it returns
// for `prefetchPromiseTypes`.
const prefetchReturnTypes = (checker: ts.TypeChecker, nodes: ReadonlyArray<FunctionLike>, caches: Caches): ts.Type[] => {
    let pending: FunctionLike[] = [];

    for (let i = 0, n = nodes.length; i < n; i++) {
        if (declaredReturnsPromise(checker, nodes[i], caches) === undefined) {
            pending.push(nodes[i]);
        }
    }

    if (pending.length === 0) {
        return [];
    }

    let types = checker.getTypeAtLocation(pending),
        typed: [ts.Type, ts.SignatureKind][] = [];

    for (let i = 0, n = types.length; i < n; i++) {
        if (types[i]) {
            typed.push([types[i], ts.SignatureKind.Call]);
        }
    }

    let signatures: [ts.Signature][] = [];

    for (let found of checkers.batch(checker, 'getSignaturesOfType', typed)) {
        if (found[0]) {
            signatures.push([found[0]]);
        }
    }

    return checkers.batch(checker, 'getReturnTypeOfSignature', signatures);
};

// Whether invoking this function yields a promise the caller must own.
const returnsPromise = (checker: ts.TypeChecker, node: FunctionLike, caches: Caches): boolean => {
    return declaredReturnsPromise(checker, node, caches) ?? inferredReturnsPromise(checker, node, caches);
};


export type { Caches };
export { declaredReturnsPromise, inferredReturnsPromise, isPromiseType, prefetchPromiseTypes, prefetchReturnTypes, returnsPromise };
