import type { ImportIntent, Plugin, Replacement, ReplacementIntent, SharedContext } from './types';
import { ts } from '~/index';
import imports, { ModifyOptions } from './imports';


type CoordinatorResult = {
    changed: boolean;
    code: string;
    sourceFile: ts.SourceFile;
};


function applyImports(
    sourceCode: string,
    sourceFile: ts.SourceFile,
    intents: ImportIntent[]
): string {
    let result = sourceCode;

    for (let i = 0, n = intents.length; i < n; i++) {
        let intent = intents[i];

        result = modify(result, sourceFile, intent.package, {
            add: intent.add,
            namespace: intent.namespace,
            remove: intent.remove
        });

        if (i < n - 1) {
            sourceFile = ts.createSourceFile(
                sourceFile.fileName,
                result,
                sourceFile.languageVersion,
                true
            );
        }
    }

    return result;
}

function applyIntents(
    sourceCode: string,
    sourceFile: ts.SourceFile,
    intents: ReplacementIntent[]
): string {
    if (intents.length === 0) {
        return sourceCode;
    }

    return replaceReverse(
        sourceCode,
        intents.map(intent => ({
            end: intent.node.end,
            newText: intent.generate(sourceFile),
            start: intent.node.getStart(sourceFile)
        }))
    );
}

function applyPrepend(sourceCode: string, sourceFile: ts.SourceFile, prepend: string[]): string {
    if (prepend.length === 0) {
        return sourceCode;
    }

    let insertPos = findLastImportEnd(sourceFile),
        prependText = prepend.join('\n') + '\n';

    if (insertPos === 0) {
        return prependText + sourceCode;
    }

    return sourceCode.slice(0, insertPos) + '\n' + prependText + sourceCode.slice(insertPos);
}

function findLastImportEnd(sourceFile: ts.SourceFile): number {
    let lastEnd = 0;

    for (let i = 0, n = sourceFile.statements.length; i < n; i++) {
        let stmt = sourceFile.statements[i];

        if (ts.isImportDeclaration(stmt)) {
            lastEnd = stmt.end;
        }
        else {
            break;
        }
    }

    return lastEnd;
}

function hasPattern(sourceCode: string, patterns: string[]): boolean {
    for (let i = 0, n = patterns.length; i < n; i++) {
        if (sourceCode.indexOf(patterns[i]) !== -1) {
            return true;
        }
    }

    return false;
}

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
        found = imports.find(sourceFile, packageName),
        remove = options.remove ? new Set(options.remove) : null;

    if (found.length === 0) {
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

    for (let i = 0, n = found.length; i < n; i++) {
        for (let [name, alias] of found[i].specifiers) {
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

    for (let i = 0, n = found.length; i < n; i++) {
        replacements.push({
            end: found[i].end,
            newText: i === 0 ? statements.join('\n') : '',
            start: found[i].start
        });
    }

    return replaceReverse(sourceCode, replacements);
};

const replaceReverse = (code: string, replacements: Replacement[]): string => {
    if (replacements.length === 0) {
        return code;
    }

    replacements.sort((a, b) => b.start - a.start);

    let result = code;

    for (let i = 0, n = replacements.length; i < n; i++) {
        let r = replacements[i];

        result = result.substring(0, r.start) + r.newText + result.substring(r.end);
    }

    return result;
};


/**
 * Transform source through all plugins sequentially.
 * Each plugin receives fresh AST with accurate positions.
 */
const transform = (
    plugins: Plugin[],
    sourceCode: string,
    sourceFile: ts.SourceFile,
    program: ts.Program,
    shared: SharedContext
): CoordinatorResult => {
    if (plugins.length === 0) {
        return { changed: false, code: sourceCode, sourceFile };
    }

    let changed = false,
        currentCode = sourceCode,
        currentSourceFile = sourceFile;

    for (let i = 0, n = plugins.length; i < n; i++) {
        let plugin = plugins[i];

        if (plugin.patterns && !hasPattern(currentCode, plugin.patterns)) {
            continue;
        }

        let result = plugin.transform({
            checker: program.getTypeChecker(),
            code: currentCode,
            program,
            shared,
            sourceFile: currentSourceFile
        });

        let hasChanges = (result.imports && result.imports.length > 0) ||
            (result.prepend && result.prepend.length > 0) ||
            (result.replacements && result.replacements.length > 0);

        if (!hasChanges) {
            continue;
        }

        changed = true;

        if (result.replacements && result.replacements.length > 0) {
            currentCode = applyIntents(currentCode, currentSourceFile, result.replacements);
            currentSourceFile = ts.createSourceFile(
                currentSourceFile.fileName,
                currentCode,
                currentSourceFile.languageVersion,
                true
            );
        }

        if (result.prepend && result.prepend.length > 0) {
            currentCode = applyPrepend(currentCode, currentSourceFile, result.prepend);
            currentSourceFile = ts.createSourceFile(
                currentSourceFile.fileName,
                currentCode,
                currentSourceFile.languageVersion,
                true
            );
        }

        if (result.imports && result.imports.length > 0) {
            currentCode = applyImports(currentCode, currentSourceFile, result.imports);
            currentSourceFile = ts.createSourceFile(
                currentSourceFile.fileName,
                currentCode,
                currentSourceFile.languageVersion,
                true
            );
        }
    }

    return { changed, code: currentCode, sourceFile: currentSourceFile };
};


export default { transform };
export type { CoordinatorResult };
