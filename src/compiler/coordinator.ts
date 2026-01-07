import type { ImportIntent, Plugin, ReplacementIntent, SharedContext } from './types';
import { ts } from '~/index';
import code from './code';
import imports from './imports';


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

        result = imports.modify(result, sourceFile, intent.package, {
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

    let replacements = intents.map(intent => ({
        end: intent.node.end,
        newText: intent.generate(sourceFile),
        start: intent.node.getStart(sourceFile)
    }));

    return code.replaceReverse(sourceCode, replacements);
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
