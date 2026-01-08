import { ts } from '~/index';


type ImportInfo = {
    end: number;
    specifiers: Map<string, string>;
    start: number;
};

type ModifyOptions = {
    add?: Iterable<string>;
    namespace?: string;
    remove?: Iterable<string>;
};


let cache = new WeakMap<ts.SourceFile, Map<string, Set<string>>>();


// Find all named imports from a specific package
const all = (file: ts.SourceFile, pkg: string): ImportInfo[] => {
    let imports: ImportInfo[] = [];

    for (let i = 0, n = file.statements.length; i < n; i++) {
        let stmt = file.statements[i];

        if (!ts.isImportDeclaration(stmt)) {
            continue;
        }

        let moduleSpecifier = stmt.moduleSpecifier;

        if (!ts.isStringLiteral(moduleSpecifier) || moduleSpecifier.text !== pkg) {
            continue;
        }

        let bindings = stmt.importClause?.namedBindings,
            specifiers = new Map<string, string>();

        if (bindings && ts.isNamedImports(bindings)) {
            for (let j = 0, m = bindings.elements.length; j < m; j++) {
                let element = bindings.elements[j],
                    name = element.name.text,
                    propertyName = element.propertyName?.text || name;

                specifiers.set(propertyName, name);
            }
        }

        imports.push({ end: stmt.end, specifiers, start: stmt.getStart(file) });
    }

    return imports;
};

// Check if node's symbol originates from a specific package (with optional symbol name validation)
const includes = (checker: ts.TypeChecker, node: ts.Node, pkg: string, symbolName?: string): boolean => {
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

    // If no imports from this package, definitely not from it
    if (names.size === 0) {
        return false;
    }

    // For identifiers, check if name matches an import AND verify via symbol
    if (ts.isIdentifier(node)) {
        if (!names.has(node.text)) {
            return false;
        }

        if (symbolName && node.text !== symbolName) {
            return false;
        }

        // Try to verify via checker that this identifier refers to the import
        let symbol = checker.getSymbolAtLocation(node);

        if (symbol) {
            // Check if the symbol's declaration is an import specifier from this package
            let declarations = symbol.getDeclarations();

            if (declarations && declarations.length > 0) {
                for (let i = 0, n = declarations.length; i < n; i++) {
                    let decl = declarations[i];

                    // If declaration is an ImportSpecifier, check the import's module
                    if (ts.isImportSpecifier(decl)) {
                        let importDecl = decl.parent?.parent?.parent;

                        if (importDecl && ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
                            if (importDecl.moduleSpecifier.text === pkg) {
                                return true;
                            }
                        }
                    }

                    // Also check if declaration is from a file in the package
                    if (decl.getSourceFile().fileName.includes(pkg)) {
                        return true;
                    }
                }

                // Symbol resolved but doesn't match package - it's shadowed
                return false;
            }
        }

        // Checker couldn't resolve - trust the name match if it's in import list
        return true;
    }

    return false;
};


export default { all, includes };
export type { ImportInfo, ModifyOptions };
