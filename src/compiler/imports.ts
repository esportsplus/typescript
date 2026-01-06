import type { Replacement } from './types.js';
import { ts } from '~/index.js';
import code from './code.js';


type ImportInfo = {
    end: number;
    specifiers: Map<string, string>;
    start: number;
};

type ModifyOptions = {
    add?: Iterable<string>;
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

        imports.push({ end: stmt.end, specifiers, start: stmt.getStart() });
    }

    return imports;
};

// Check if identifier traces back to a specific package
const isFromPackage = (node: ts.Identifier, packageName: string, checker?: ts.TypeChecker): boolean => {
    if (!checker) {
        return true;
    }

    let origin = trace(node, checker);

    return origin !== null && origin.includes(packageName);
};


// Modify imports: remove specified, add needed, delete if empty
const modify = (
    sourceCode: string,
    sourceFile: ts.SourceFile,
    packageName: string,
    options: ModifyOptions
): string => {
    // Fast path: nothing to change
    if (!options.add && !options.remove) {
        return sourceCode;
    }

    let add = options.add ? new Set(options.add) : null,
        imports = find(sourceFile, packageName),
        remove = options.remove ? new Set(options.remove) : null;

    if (imports.length === 0) {
        if (!add || add.size === 0) {
            return sourceCode;
        }

        return `import { ${[...add].sort().join(', ')} } from '${packageName}';\n` + sourceCode;
    }

    // Collect all non-removed specifiers from existing imports
    let specifiers = new Set<string>();

    for (let i = 0, n = imports.length; i < n; i++) {
        for (let [name, alias] of imports[i].specifiers) {
            if (!remove || (!remove.has(name) && !remove.has(alias))) {
                specifiers.add(name === alias ? name : `${name} as ${alias}`);
            }
        }
    }

    if (add) {
        for (let name of add) {
            specifiers.add(name);
        }
    }

    // Build replacements - replace first import, remove others
    let replacements: Replacement[] = [],
        sorted = [...specifiers].sort().join(', ');

    for (let i = 0, n = imports.length; i < n; i++) {
        replacements.push({
            end: imports[i].end,
            newText: i === 0 && specifiers.size > 0
                ? `import { ${sorted} } from '${packageName}';`
                : '',
            start: imports[i].start
        });
    }

    return code.replaceReverse(sourceCode, replacements);
};

// Trace symbol through re-exports to find original declaration source file
const trace = (node: ts.Identifier, checker: ts.TypeChecker): string | null => {
    let symbol = checker.getSymbolAtLocation(node);

    if (!symbol) {
        return null;
    }

    if (symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
    }

    let declarations = symbol.getDeclarations();

    if (!declarations || declarations.length === 0) {
        return null;
    }

    return declarations[0].getSourceFile().fileName;
};


export default { find, isFromPackage, modify, trace };
export type { ImportInfo, ModifyOptions };
