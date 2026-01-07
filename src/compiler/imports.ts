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


// Find all named imports from a specific package
const find = (sourceFile: ts.SourceFile, packageName: string): ImportInfo[] => {
    let imports: ImportInfo[] = [];

    for (let i = 0, n = sourceFile.statements.length; i < n; i++) {
        let stmt = sourceFile.statements[i];

        if (!ts.isImportDeclaration(stmt)) {
            continue;
        }

        let moduleSpecifier = stmt.moduleSpecifier;

        if (!ts.isStringLiteral(moduleSpecifier) || moduleSpecifier.text !== packageName) {
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

        imports.push({ end: stmt.end, specifiers, start: stmt.getStart(sourceFile) });
    }

    return imports;
};

// Check if node's symbol originates from a specific package (with optional symbol name validation)
const inPackage = (
    checker: ts.TypeChecker,
    node: ts.Node,
    pkg: string,
    symbolName?: string,
    packageImports?: Set<string>
): boolean => {
    // Fast path: identifier matches known import and expected name
    if (packageImports && ts.isIdentifier(node) && packageImports.has(node.text)) {
        if (!symbolName || node.text === symbolName) {
            return true;
        }
    }

    let symbol = checker.getSymbolAtLocation(node);

    if (!symbol) {
        // Fallback: aliased import - check if local name is in imports
        if (packageImports && ts.isIdentifier(node) && packageImports.has(node.text)) {
            return true;
        }

        return false;
    }

    // Follow aliases to original symbol (handles re-exports and aliased imports)
    if (symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
    }

    // Check symbol name if specified
    if (symbolName && symbol.name !== symbolName) {
        return packageImports ? ts.isIdentifier(node) && packageImports.has(node.text) : false;
    }

    let declarations = symbol.getDeclarations();

    if (!declarations || declarations.length === 0) {
        return packageImports ? ts.isIdentifier(node) && packageImports.has(node.text) : false;
    }

    // Check if any declaration is from the expected package
    for (let i = 0, n = declarations.length; i < n; i++) {
        if (declarations[i].getSourceFile().fileName.includes(pkg)) {
            return true;
        }
    }

    return packageImports ? ts.isIdentifier(node) && packageImports.has(node.text) : false;
};


export default { find, inPackage };
export type { ImportInfo, ModifyOptions };
