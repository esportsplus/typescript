import type { Node, SourceFile } from 'typescript/unstable/ast';
import { SyntaxKind } from 'typescript/unstable/ast';
import { isIdentifier, isImportDeclaration, isNamedImports, isStringLiteral } from 'typescript/unstable/ast/is';
import type { Checker } from 'typescript/unstable/sync';
import { SymbolFlags } from 'typescript/unstable/sync';


type ImportInfo = {
    end: number;
    specifiers: Map<string, string>;
    // propertyName keys that were imported type-only, whether via a type-only clause
    // (`import type { A }`) or an inline specifier (`import { type A }`). Preserved so a rewrite
    // re-emits them as type imports instead of runtime imports.
    typeOnly: Set<string>;
    start: number;
};

type ModifyOptions = {
    add?: Iterable<string>;
    namespace?: string;
    remove?: Iterable<string>;
};


let cache = new WeakMap<SourceFile, Map<string, Set<string>>>();


function fileNameMatchesPackage(fileName: string, pkg: string): boolean {
    // NodeHandle.path is a canonicalized (possibly lower-cased) Path; npm names are lowercase by registry rule, so the substring match is safe without case-folding.
    let normalized = fileName.replace(/\\/g, '/'),
        marker = `/node_modules/${pkg}/`;

    return normalized.includes(marker);
}


// Find all named imports from a specific package
const all = (file: SourceFile, pkg: string): ImportInfo[] => {
    let imports: ImportInfo[] = [];

    for (let i = 0, n = file.statements.length; i < n; i++) {
        let stmt = file.statements[i];

        if (!isImportDeclaration(stmt)) {
            continue;
        }

        let moduleSpecifier = stmt.moduleSpecifier;

        if (!isStringLiteral(moduleSpecifier) || moduleSpecifier.text !== pkg) {
            continue;
        }

        let bindings = stmt.importClause?.namedBindings,
            declTypeOnly = stmt.importClause?.phaseModifier === SyntaxKind.TypeKeyword,
            specifiers = new Map<string, string>(),
            typeOnly = new Set<string>();

        if (bindings && isNamedImports(bindings)) {
            for (let j = 0, m = bindings.elements.length; j < m; j++) {
                let element = bindings.elements[j],
                    name = element.name.text,
                    propertyName = element.propertyName?.text || name;

                specifiers.set(propertyName, name);

                if (declTypeOnly || element.isTypeOnly) {
                    typeOnly.add(propertyName);
                }
            }
        }

        imports.push({ end: stmt.end, specifiers, start: stmt.getStart(file), typeOnly });
    }

    return imports;
};

// Check if node's symbol originates from a specific package (with optional symbol name validation)
const includes = (checker: Checker, node: Node, pkg: string, symbolName?: string): boolean => {
    if (!isIdentifier(node)) {
        return false;
    }

    if (symbolName && node.text !== symbolName) {
        return false;
    }

    let file = node.getSourceFile(),
        imports = cache.get(file);

    if (!imports) {
        imports = new Map();
        cache.set(file, imports);
    }

    let names = imports.get(pkg);

    if (!names) {
        names = new Set();

        let packages = all(file, pkg);

        for (let i = 0, n = packages.length; i < n; i++) {
            for (let [, localName] of packages[i].specifiers) {
                names.add(localName);
            }
        }

        imports.set(pkg, names);
    }

    // Fast path: direct import from package
    if (names.has(node.text)) {
        let symbol = checker.getSymbolAtLocation(node);

        if (symbol) {
            let declarations = symbol.declarations;

            if (declarations && declarations.length > 0) {
                for (let i = 0, n = declarations.length; i < n; i++) {
                    let handle = declarations[i];

                    if (handle.kind === SyntaxKind.ImportSpecifier) {
                        let decl = handle.resolve();

                        if (decl) {
                            let importDecl = decl.parent?.parent?.parent;

                            if (importDecl && isImportDeclaration(importDecl) && isStringLiteral(importDecl.moduleSpecifier)) {
                                if (importDecl.moduleSpecifier.text === pkg) {
                                    return true;
                                }
                            }
                        }
                    }

                    if (fileNameMatchesPackage(handle.path, pkg)) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    // Slow path: check for re-exports via aliased symbol
    let symbol = checker.getSymbolAtLocation(node);

    if (!symbol) {
        return false;
    }

    // Check declarations
    let declarations = symbol.declarations;

    if (declarations && declarations.length > 0) {
        for (let i = 0, n = declarations.length; i < n; i++) {
            let handle = declarations[i];

            if (fileNameMatchesPackage(handle.path, pkg)) {
                return true;
            }
        }
    }

    // Check aliased symbol for re-exports
    if ((symbol.flags & SymbolFlags.Alias) !== 0) {
        let aliased = checker.getAliasedSymbol(symbol);

        if (aliased && aliased !== symbol) {
            let aliasedDecls = aliased.declarations;

            if (aliasedDecls) {
                for (let i = 0, n = aliasedDecls.length; i < n; i++) {
                    if (fileNameMatchesPackage(aliasedDecls[i].path, pkg)) {
                        return true;
                    }
                }
            }
        }
    }

    return false;
};


export default { all, includes };
export type { ImportInfo, ModifyOptions };
