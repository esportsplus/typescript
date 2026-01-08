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

    let varnames = imports.get(pkg);

    if (!varnames) {
        varnames = new Set();

        for (let info of all(file, pkg)) {
            for (let [, varname] of info.specifiers) {
                varnames.add(varname);
            }
        }

        imports.set(pkg, varnames);
    }

    // Fast path: identifier matches known import and expected name
    if (ts.isIdentifier(node) && varnames.has(node.text) && (!symbolName || node.text === symbolName)) {
        return true;
    }

    let symbol = checker.getSymbolAtLocation(node);

    if (!symbol) {
        // Fallback: aliased import - check if local name is in imports
        if (ts.isIdentifier(node) && varnames.has(node.text)) {
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
        return ts.isIdentifier(node) && varnames.has(node.text);
    }

    let declarations = symbol.getDeclarations();

    if (!declarations || declarations.length === 0) {
        return ts.isIdentifier(node) && varnames.has(node.text);
    }

    // Check if any declaration is from the expected package
    for (let i = 0, n = declarations.length; i < n; i++) {
        if (declarations[i].getSourceFile().fileName.includes(pkg)) {
            return true;
        }
    }

    return ts.isIdentifier(node) && varnames.has(node.text);
};


export default { all, includes };
export type { ImportInfo, ModifyOptions };
