import type { Replacement } from './types';
import { ts } from '~/index';
import code from './code';


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

// Modify imports: remove specified, add needed, delete if empty
const modify = (
    sourceCode: string,
    sourceFile: ts.SourceFile,
    packageName: string,
    options: ModifyOptions
): string => {
    let { namespace } = options;

    // Fast path: nothing to change
    if (!options.add && !options.namespace && !options.remove) {
        return sourceCode;
    }

    let add = options.add ? new Set(options.add) : null,
        imports = find(sourceFile, packageName),
        remove = options.remove ? new Set(options.remove) : null;

    if (imports.length === 0) {
        let statements: string[] = [];

        if (namespace) {
            statements.push(`import * as ${namespace} from '${packageName}';`);
        }

        if (add && add.size > 0) {
            statements.push(`import { ${[...add].sort().join(', ')} } from '${packageName}';`);
        }

        if (statements.length === 0) {
            return sourceCode;
        }

        return statements.join('\n') + '\n' + sourceCode;
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

    // Build replacement text - namespace import first, then named imports
    let statements: string[] = [];

    if (namespace) {
        statements.push(`import * as ${namespace} from '${packageName}';`);
    }

    if (specifiers.size > 0) {
        statements.push(`import { ${[...specifiers].sort().join(', ')} } from '${packageName}';`);
    }

    // Build replacements - replace first import, remove others
    let replacements: Replacement[] = [];

    for (let i = 0, n = imports.length; i < n; i++) {
        replacements.push({
            end: imports[i].end,
            newText: i === 0 ? statements.join('\n') : '',
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


export default { find, inPackage, modify, trace };
export type { ImportInfo, ModifyOptions };
