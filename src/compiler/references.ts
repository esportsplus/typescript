import type { Node, SourceFile } from 'typescript/ast';
import { NodeFlags, SyntaxKind } from 'typescript/ast';
import {
    isArrayBindingPattern, isArrayLiteralExpression, isAsExpression, isAssignmentOperator, isAwaitExpression,
    isBinaryExpression, isBindingElement, isCallExpression, isElementAccessExpression, isForInStatement,
    isForOfStatement, isIdentifier, isImportClause, isImportEqualsDeclaration, isImportSpecifier, isImportTypeNode,
    isNamespaceImport, isNonNullExpression, isNoSubstitutionTemplateLiteral, isObjectBindingPattern,
    isObjectLiteralExpression, isParameterDeclaration, isParenthesizedExpression, isPropertyAccessExpression,
    isPropertyAssignment, isQualifiedName, isSatisfiesExpression, isShorthandPropertyAssignment, isSpreadAssignment,
    isSpreadElement, isStringLiteral, isTypeAssertion, isTypeNode, isTypeQueryNode, isVariableDeclaration,
    isVariableDeclarationList
} from 'typescript/ast/is';
import type { Checker, NodeHandle, Program, Symbol } from 'typescript/sync';
import { SymbolFlags } from 'typescript/sync';

import manifest from './manifest';


// Names a value binds (a declaration's initializer, a for-of/in iteration, an assignment's right side)
// and what the value reads, so the names can be kept once anything it reads is
type Binding = {
    // Whether the value loads a module itself (`import()`, `require()`)
    loads: boolean;
    names: string[];
    reads: Set<string>;
};

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


// The module types an annotation spells: `typeof import('x')` loads one, `typeof ns.a` reads `ns`
function annotation(node: Node, binding: Binding): void {
    if (isImportTypeNode(node)) {
        binding.loads ||= node.isTypeOf;

        return;
    }

    if (isTypeQueryNode(node)) {
        let root: Node = node.exprName;

        while (isQualifiedName(root)) {
            root = root.left;
        }

        if (isIdentifier(root)) {
            binding.reads.add(root.text);
        }

        return;
    }

    node.forEachChild(child => annotation(child, binding));
}

function binding(target: Node, value: Node): Binding {
    let result: Binding = { loads: false, names: [], reads: new Set() };

    bound(target, result.names);
    reads(value, result);

    return result;
}

// Names a declaration name or an assignment target binds, through destructuring patterns and
// destructuring assignment literals; a member target (`a.b = ...`) binds no variable
function bound(target: Node, names: string[]): void {
    if (isIdentifier(target)) {
        names.push(target.text);
    }
    else if (isObjectBindingPattern(target) || isArrayBindingPattern(target)) {
        target.forEachChild(element => {
            if (isBindingElement(element) && element.name) {
                bound(element.name, names);
            }
        });
    }
    else if (isArrayLiteralExpression(target)) {
        for (let i = 0, n = target.elements.length; i < n; i++) {
            bound(target.elements[i], names);
        }
    }
    else if (isObjectLiteralExpression(target)) {
        for (let i = 0, n = target.properties.length; i < n; i++) {
            let property = target.properties[i];

            if (isShorthandPropertyAssignment(property)) {
                bound(property.name, names);
            }
            else if (isPropertyAssignment(property)) {
                bound(property.initializer, names);
            }
            else if (isSpreadAssignment(property)) {
                bound(property.expression, names);
            }
        }
    }
    else if (isSpreadElement(target) || isParenthesizedExpression(target)) {
        bound(target.expression, names);
    }
    else if (isBinaryExpression(target)) {
        bound(target.left, names);
    }
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

// Values the checker is asked about: reads rooted in the file's import bindings, whatever they are
// called. Kept are (1) every local name an import introduces, (2) members (`ns.x`, `ns['x']`) whose
// receiver chain roots in a kept name or a module load, and (3) names bound from a value reading a
// kept name or annotated with a module's type, to a fixpoint (`const h = html`,
// `let x; x = reactive(0)`, `(ns: typeof import('x')) => ns.html`). The checker still decides what
// each resolves to, so renames, re-exports and shadowing resolve as before; what is dropped
// (parameters, functions, classes, locals never bound from an import, members of other receivers)
// only ever resolved to declarations holds() rejects by kind.
function candidates(file: SourceFile): Node[] {
    let bindings: Binding[] = [],
        found: Node[] = [],
        roots = new Set<string>();

    scan(file, roots, bindings);

    let kept = roots,
        pending = bindings;

    for (let changed = true; changed;) {
        let next: Binding[] = [];

        changed = false;

        for (let i = 0, n = pending.length; i < n; i++) {
            let binding = pending[i];

            if (!binding.loads && !reaches(binding.reads, kept)) {
                next.push(binding);
                continue;
            }

            for (let j = 0, m = binding.names.length; j < m; j++) {
                if (!kept.has(binding.names[j])) {
                    kept.add(binding.names[j]);
                    changed = true;
                }
            }
        }

        pending = next;
    }

    collect(file, found, kept);

    return found;
}

function collect(node: Node, found: Node[], kept: Set<string>): void {
    if (isTypeNode(node)) {
        return;
    }

    let parent = node.parent;

    if (isIdentifier(node)) {
        if (!LINKS.has(parent?.kind as SyntaxKind) && !isDeclarationName(node)) {
            if (parent !== undefined && isPropertyAccessExpression(parent) && parent.name === node) {
                if (rooted(parent.expression, kept)) {
                    found.push(node);
                }
            }
            else if (kept.has(node.text)) {
                found.push(node);
            }
        }
    }
    else if (
        (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) &&
        parent !== undefined &&
        isElementAccessExpression(parent) &&
        parent.argumentExpression === node &&
        rooted(parent.expression, kept)
    ) {
        found.push(node);
    }

    node.forEachChild(child => collect(child, found, kept));
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

// `import()` and `require()` load a module without an import declaration to bind it
function isLoad(node: Node): boolean {
    return isCallExpression(node) && (
        node.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(node.expression) && node.expression.text === 'require')
    );
}

function reaches(reads: Set<string>, kept: Set<string>): boolean {
    for (let name of reads) {
        if (kept.has(name)) {
            return true;
        }
    }

    return false;
}

// Every name a value reads (member names excluded: `a.b` reads `a`), and whether it loads a module
function reads(node: Node, binding: Binding): void {
    if (isTypeNode(node)) {
        return;
    }

    if (isIdentifier(node)) {
        let parent = node.parent;

        if (!(parent !== undefined && isPropertyAccessExpression(parent) && parent.name === node)) {
            binding.reads.add(node.text);
        }

        return;
    }

    if (isLoad(node)) {
        binding.loads = true;
    }

    node.forEachChild(child => reads(child, binding));
}

// Whether a receiver chain (`ns`, `ns.a.b`, `ns['a']`, `(await import('x')).a`) starts at a kept
// name or a module load; a call result, `this` or any other receiver never reaches an export
function rooted(expression: Node, kept: Set<string>): boolean {
    while (true) {
        if (
            isAsExpression(expression) ||
            isAwaitExpression(expression) ||
            isNonNullExpression(expression) ||
            isParenthesizedExpression(expression) ||
            isSatisfiesExpression(expression) ||
            isTypeAssertion(expression)
        ) {
            expression = (expression as Node & { expression: Node }).expression;
        }
        else if (isPropertyAccessExpression(expression) || isElementAccessExpression(expression)) {
            expression = expression.expression;
        }
        else {
            break;
        }
    }

    return isIdentifier(expression) ? kept.has(expression.text) : isLoad(expression);
}

function scan(node: Node, roots: Set<string>, bindings: Binding[]): void {
    if (isTypeNode(node)) {
        return;
    }

    if (isImportClause(node) || isImportEqualsDeclaration(node) || isImportSpecifier(node) || isNamespaceImport(node)) {
        let name = (node as { name?: Node }).name;

        if (name && isIdentifier(name)) {
            roots.add(name.text);
        }
    }
    else if (isVariableDeclaration(node)) {
        let source = value(node);

        if (source) {
            bindings.push(binding(node.name, source));
        }

        if (node.type) {
            typed(node.name, node.type, bindings);
        }
    }
    else if (isParameterDeclaration(node) && node.type) {
        typed(node.name, node.type, bindings);
    }
    else if (isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        bindings.push(binding(node.left, node.right));
    }

    node.forEachChild(child => scan(child, roots, bindings));
}

// A name annotated with a module's type (`typeof import('x')`, `typeof ns` for a kept `ns`) holds
// that module's namespace, so its members are the module's exports whatever value it is given
function typed(name: Node, type: Node, bindings: Binding[]): void {
    let binding: Binding = { loads: false, names: [], reads: new Set() };

    annotation(type, binding);

    if (binding.loads || binding.reads.size > 0) {
        bound(name, binding.names);
        bindings.push(binding);
    }
}

// What a variable declaration binds from: its initializer, or what a for-of/in loop iterates
function value(declaration: Node & { initializer?: Node }): Node | undefined {
    if (declaration.initializer) {
        return declaration.initializer;
    }

    let statement = declaration.parent?.parent;

    if (statement && (isForOfStatement(statement) || isForInStatement(statement))) {
        return statement.expression;
    }

    return undefined;
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

    // The expression is usually an initializer in another file: resolving every read there just to
    // look this one up would type-check that whole file, so a file not yet resolved is asked once
    let resolved = cache.get(program)?.get(`origins\0${name.getSourceFile().fileName}`) as Map<Node, Origin> | undefined;

    return holds(checker, program, resolved?.get(name) ?? origin(checker, program, name), targets);
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

// Origin of every value read in a file that can resolve to an export or a variable bound from one
// (see candidates): identifiers, member names and string keys of element accesses, resolved in one
// checker round-trip. Type positions and the identifiers of import/export clauses are excluded;
// declaration names are not reads.
const origins = (checker: Checker, program: Program, file: SourceFile): Map<Node, Origin> => {
    return cached(program, `origins\0${file.fileName}`, () => {
        let result = new Map<Node, Origin>();

        let identifiers = candidates(file);

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
