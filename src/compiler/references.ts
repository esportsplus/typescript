import type { Node, SourceFile } from 'typescript/unstable/ast';
import { SyntaxKind } from 'typescript/unstable/ast';
import {
    isArrayBindingPattern, isAsExpression, isBindingElement, isElementAccessExpression, isIdentifier, isImportClause,
    isImportEqualsDeclaration, isImportSpecifier, isNamespaceImport, isNonNullExpression,
    isNoSubstitutionTemplateLiteral, isObjectBindingPattern, isParenthesizedExpression, isPropertyAccessExpression,
    isSatisfiesExpression, isShorthandPropertyAssignment, isStringLiteral, isTypeAssertion, isTypeNode,
    isVariableDeclaration, isVariableDeclarationList
} from 'typescript/unstable/ast/is';
import { NodeFlags } from 'typescript/unstable/ast';
import type { Checker, NodeHandle, Program, Symbol } from 'typescript/unstable/sync';
import { SymbolFlags } from 'typescript/unstable/sync';

import manifest from './manifest';


type Origin = {
    // Declaration the value comes from once every import, re-export and namespace alias is followed
    declaration: NodeHandle;
    // Files declaring the aliases between the use and the declaration, nearest first
    through: string[];
};


// Positions that restate a binding rather than read it: import/export clauses chain one name to
// the next
const LINKS = new Set<SyntaxKind>([
    SyntaxKind.ExportAssignment,
    SyntaxKind.ExportSpecifier,
    SyntaxKind.ImportClause,
    SyntaxKind.ImportEqualsDeclaration,
    SyntaxKind.ImportSpecifier,
    SyntaxKind.NamespaceExport,
    SyntaxKind.NamespaceImport
]);


// Program snapshots are immutable, so every answer holds for the program's lifetime
let cache = new WeakMap<Program, Map<string, unknown>>(),
    signatures = new WeakMap<Set<string>, string>();


// Names a plain value read can resolve through to an export or a variable: the names this file
// imports and the names its variables bind. A read of any other name (a parameter, a function, a
// class, a global) can never reach a package export or a reactive binding.
function bound(node: Node, names: Set<string>): void {
    if (isTypeNode(node)) {
        return;
    }

    if (
        isBindingElement(node) ||
        isImportClause(node) ||
        isImportEqualsDeclaration(node) ||
        isImportSpecifier(node) ||
        isNamespaceImport(node) ||
        isVariableDeclaration(node)
    ) {
        let name = (node as { name?: Node }).name;

        if (name && isIdentifier(name)) {
            names.add(name.text);
        }
    }

    node.forEachChild(child => bound(child, names));
}


function cached<T>(program: Program, key: string, compute: () => T): T {
    let entries = cache.get(program);

    if (!entries) {
        entries = new Map();
        cache.set(program, entries);
    }

    if (!entries.has(key)) {
        entries.set(key, compute());
    }

    return entries.get(key) as T;
}

// Follows an alias one hop at a time so every file along the chain is known
function follow(checker: Checker, program: Program, symbol: Symbol): Origin | null {
    return cached(program, `follow\0${symbol.id}`, () => {
        let current = symbol,
            through: string[] = [];

        while ((current.flags & SymbolFlags.Alias) !== 0) {
            let declarations = current.declarations ?? [];

            for (let i = 0, n = declarations.length; i < n; i++) {
                if (!through.includes(declarations[i].path)) {
                    through.push(declarations[i].path);
                }
            }

            let next = checker.getImmediateAliasedSymbol(current);

            if (!next || next === current) {
                break;
            }

            current = next;
        }

        let declaration = current.valueDeclaration ?? current.declarations?.[0];

        return declaration ? { declaration, through } : null;
    });
}

// A binding that can never be reassigned, so what it was initialized with is what every use sees
function isConst(declaration: Node): boolean {
    let node: Node | undefined = declaration;

    while (node && (isBindingElement(node) || isObjectBindingPattern(node) || isArrayBindingPattern(node))) {
        node = node.parent;
    }

    return node !== undefined &&
        isVariableDeclaration(node) &&
        node.parent !== undefined &&
        isVariableDeclarationList(node.parent) &&
        (node.parent.flags & NodeFlags.Const) !== 0;
}

// A declaration's own name is where a binding starts, not a read of it: `x` in `let x`,
// `function x`, `{ x: local }` (the key) or a parameter. A property access name and a shorthand
// property read a binding, so they stay values.
function isDeclarationName(node: Node): boolean {
    let parent = node.parent;

    return parent !== undefined &&
        parent.kind !== SyntaxKind.PropertyAccessExpression &&
        parent.kind !== SyntaxKind.ShorthandPropertyAssignment &&
        (parent as { name?: Node }).name === node;
}

// Every member name is kept: a member resolves through its receiver's type, so `f().name` can
// reach an export whatever `f` is. `ns['name']` reads a member exactly like `ns.name`.
function values(node: Node, found: Node[], names: Set<string>): void {
    if (isTypeNode(node)) {
        return;
    }

    let parent = node.parent;

    if (isIdentifier(node)) {
        if (
            !LINKS.has(parent?.kind as SyntaxKind) &&
            !isDeclarationName(node) &&
            ((parent !== undefined && isPropertyAccessExpression(parent) && parent.name === node) || names.has(node.text))
        ) {
            found.push(node);
        }
    }
    else if (
        (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) &&
        parent !== undefined &&
        isElementAccessExpression(parent) &&
        parent.argumentExpression === node
    ) {
        found.push(node);
    }

    node.forEachChild(child => values(child, found, names));
}


// Whether an expression denotes one of `targets` (declaration keys): `x`, `ns.x`, `ns['x']`, in
// parentheses or under a type assertion, through any alias `holds` follows
const denotes = (checker: Checker, program: Program, expression: Node, targets: Set<string>): boolean => {
    let value = unwrap(expression),
        name = isIdentifier(value)
            ? value
            : isPropertyAccessExpression(value)
                ? value.name
                : isElementAccessExpression(value)
                    ? value.argumentExpression
                    : null;

    if (!name) {
        return false;
    }

    return holds(checker, program, origins(checker, program, name.getSourceFile()).get(name) ?? origin(checker, program, name), targets);
};

// Declarations of a package's export, one per copy of the package the program loads (two
// installed versions are two runtimes, and both must be recognized). The package is located
// through the manifests owning the program's files, so linked installs and self-references resolve.
const exported = (checker: Checker, program: Program, pkg: string, name: string): NodeHandle[] => {
    return cached(program, `exported\0${pkg}\0${name}`, () => {
        let directories = new Set<string>(),
            files = program.getSourceFileNames(),
            result: NodeHandle[] = [],
            seen = new Set<string>();

        for (let i = 0, n = files.length; i < n; i++) {
            let owner = manifest.find(files[i]);

            if (owner?.name !== pkg || directories.has(owner.directory)) {
                continue;
            }

            directories.add(owner.directory);

            for (let j = 0, m = owner.entries.length; j < m; j++) {
                let entry = program.getSourceFile(owner.entries[j]);

                if (!entry) {
                    continue;
                }

                let module = checker.getSymbolAtLocation(entry),
                    member = module && checker.getMemberInModuleExports(module, name),
                    found = member && follow(checker, program, member);

                if (found && !seen.has(key(found.declaration))) {
                    seen.add(key(found.declaration));
                    result.push(found.declaration);
                }

                break;
            }
        }

        return result;
    });
};

// Whether a value holds one of `targets` (declaration keys): the declaration itself, or a const
// binding initialized with it (`const h = html`) or destructuring it (`const { html: h } = ns`),
// followed through any number of such bindings, across files
const holds = (checker: Checker, program: Program, found: Origin | null, targets: Set<string>): boolean => {
    if (!found) {
        return false;
    }

    let declaration = found.declaration,
        id = key(declaration);

    if (targets.has(id)) {
        return true;
    }

    if (declaration.kind !== SyntaxKind.VariableDeclaration && declaration.kind !== SyntaxKind.BindingElement) {
        return false;
    }

    let signature = signatures.get(targets);

    if (signature === undefined) {
        signature = [...targets].join('|');
        signatures.set(targets, signature);
    }

    let entries = cache.get(program),
        memo = `holds\0${signature}\0${id}`;

    if (entries?.has(memo)) {
        return entries.get(memo) as boolean;
    }

    // Provisional answer breaks `const a = b, b = a` cycles
    cached(program, memo, () => false);

    let node = declaration.resolve(),
        result = false;

    if (node && isConst(node)) {
        if (isBindingElement(node)) {
            result = holds(checker, program, origin(checker, program, node), targets);
        }
        else if (isVariableDeclaration(node) && node.initializer) {
            result = denotes(checker, program, node.initializer, targets);
        }
    }

    cache.get(program)!.set(memo, result);

    return result;
};

// Identity of a declaration across handles fetched at different times
const key = (declaration: NodeHandle): string => {
    return `${declaration.path}#${declaration.index}`;
};

// Origin of one value: an identifier read, or a binding element (the property it destructures,
// `make` in `const { make: m } = ns`)
const origin = (checker: Checker, program: Program, node: Node): Origin | null => {
    let file = node.getSourceFile().fileName;

    return cached(program, `origin\0${file}\0${node.pos}\0${node.kind}`, () => {
        let parent = node.parent,
            symbol: Symbol | undefined;

        if (isBindingElement(node)) {
            let property = node.propertyName ?? node.name;

            if (!property || !isObjectBindingPattern(node.parent) || !isIdentifier(property)) {
                return null;
            }

            let initializer = (node.parent.parent as { initializer?: Node }).initializer,
                type = initializer && checker.getTypeAtLocation(initializer);

            symbol = type && checker.getPropertyOfType(type, property.text);
        }
        else if (parent && isShorthandPropertyAssignment(parent) && parent.name === node) {
            symbol = checker.getShorthandAssignmentValueSymbol(parent);
        }
        else {
            symbol = checker.getSymbolAtLocation(node);
        }

        return symbol ? follow(checker, program, symbol) : null;
    });
};

// Origin of every value read in a file that can resolve to an export or a variable (see bound):
// identifiers, member names and string keys of element accesses, resolved in one checker
// round-trip. Type positions and the identifiers of import/export clauses are excluded;
// declaration names are not reads.
const origins = (checker: Checker, program: Program, file: SourceFile): Map<Node, Origin> => {
    return cached(program, `origins\0${file.fileName}`, () => {
        let identifiers: Node[] = [],
            names = new Set<string>(),
            result = new Map<Node, Origin>();

        bound(file, names);
        values(file, identifiers, names);

        let symbols = checker.getSymbolAtLocation(identifiers);

        for (let i = 0, n = identifiers.length; i < n; i++) {
            let identifier = identifiers[i],
                parent = identifier.parent!,
                symbol = isShorthandPropertyAssignment(parent) && parent.name === identifier
                    ? checker.getShorthandAssignmentValueSymbol(parent)
                    : symbols[i],
                found = symbol && follow(checker, program, symbol);

            if (found) {
                result.set(identifier, found);
            }
        }

        return result;
    });
};


// The expression a value comes from, without parentheses, `!` and type assertions
const unwrap = (expression: Node): Node => {
    while (
        isAsExpression(expression) ||
        isNonNullExpression(expression) ||
        isParenthesizedExpression(expression) ||
        isSatisfiesExpression(expression) ||
        isTypeAssertion(expression)
    ) {
        expression = (expression as Node & { expression: Node }).expression;
    }

    return expression;
};


export default { denotes, exported, holds, key, origin, origins, unwrap };
export type { Origin };
