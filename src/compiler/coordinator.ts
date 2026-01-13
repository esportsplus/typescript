import type { ImportIntent, Plugin, Replacement, ReplacementIntent, SharedContext } from './types';
import { ts } from '~/index';
import imports, { ModifyOptions } from './imports';


type CoordinatorResult = {
    changed: boolean;
    code: string;
    sourceFile: ts.SourceFile;
};


function applyImports(code: string, file: ts.SourceFile, intents: ImportIntent[]): string {
    for (let i = 0, n = intents.length; i < n; i++) {
        let intent = intents[i];

        code = modify(code, file, intent.package, {
            add: intent.add,
            namespace: intent.namespace,
            remove: intent.remove
        });

        if (i < n - 1) {
            file = ts.createSourceFile(
                file.fileName,
                code,
                file.languageVersion,
                true
            );
        }
    }

    return code;
}

function applyIntents(code: string, file: ts.SourceFile, intents: ReplacementIntent[]): string {
    if (intents.length === 0) {
        return code;
    }

    return replaceReverse(
        code,
        intents.map(intent => ({
            end: intent.node.end,
            newText: intent.generate(file),
            start: intent.node.getStart(file)
        }))
    );
}

function applyPrepend(code: string, file: ts.SourceFile, prepend: string[]): string {
    if (prepend.length === 0) {
        return code;
    }

    let position = 0;

    for (let i = 0, n = file.statements.length; i < n; i++) {
        let stmt = file.statements[i];

        if (ts.isImportDeclaration(stmt)) {
            position = stmt.end;
        }
        else {
            break;
        }
    }

    if (position === 0) {
        return prepend.join('\n') + code;
    }

    return code.slice(0, position) + prepend.join('\n') + code.slice(position);
}

function hasPattern(code: string, patterns: string[]): boolean {
    for (let i = 0, n = patterns.length; i < n; i++) {
        if (code.indexOf(patterns[i]) !== -1) {
            return true;
        }
    }

    return false;
}

function modify(code: string, file: ts.SourceFile, pkg: string, options: ModifyOptions): string {
    if (!options.add && !options.namespace && !options.remove) {
        return code;
    }

    let { namespace } = options,
        add = options.add ? new Set(options.add) : null,
        found = imports.all(file, pkg);

    if (found.length === 0) {
        let statements: string[] = [];

        if (namespace) {
            statements.push(`import * as ${namespace} from '${pkg}';`);
        }

        if (add && add.size > 0) {
            statements.push(`import { ${[...add].sort().join(', ')} } from '${pkg}';`);
        }

        if (statements.length === 0) {
            return code;
        }

        return statements.join('\n') + '\n' + code;
    }

    let remove = options.remove ? new Set(options.remove) : null,
        specifiers = new Set<string>();

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

    let statements: string[] = [];

    if (namespace) {
        statements.push(`import * as ${namespace} from '${pkg}';`);
    }

    if (specifiers.size > 0) {
        statements.push(`import { ${[...specifiers].sort().join(', ')} } from '${pkg}';`);
    }

    let replacements: Replacement[] = [];

    for (let i = 0, n = found.length; i < n; i++) {
        replacements.push({
            end: found[i].end,
            newText: i === 0 ? statements.join('\n') : '',
            start: found[i].start
        });
    }

    return replaceReverse(code, replacements);
};

function replaceReverse(code: string, replacements: Replacement[]): string {
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
 * All plugins share the original program type checker for import resolution.
 */
const transform = (
    plugins: Plugin[],
    code: string,
    file: ts.SourceFile,
    program: ts.Program,
    shared: SharedContext
): CoordinatorResult => {
    if (plugins.length === 0) {
        return { changed: false, code, sourceFile: file };
    }

    let checker = program.getTypeChecker(),
        currentCode = code,
        currentFile = file,
        fileName = file.fileName;

    for (let i = 0, n = plugins.length; i < n; i++) {
        let plugin = plugins[i];

        if (plugin.patterns && !hasPattern(currentCode, plugin.patterns)) {
            continue;
        }

        let { imports, prepend, replacements } = plugin.transform({
                checker,
                code: currentCode,
                program,
                shared,
                sourceFile: currentFile
            });

        if (replacements?.length) {
            currentCode = applyIntents(currentCode, currentFile, replacements);
            currentFile = ts.createSourceFile(
                fileName,
                currentCode,
                currentFile.languageVersion,
                true
            );
        }

        if (prepend?.length) {
            currentCode = applyPrepend(currentCode, currentFile, prepend);
            currentFile = ts.createSourceFile(
                fileName,
                currentCode,
                currentFile.languageVersion,
                true
            );
        }

        if (imports?.length) {
            currentCode = applyImports(currentCode, currentFile, imports);
            currentFile = ts.createSourceFile(
                fileName,
                currentCode,
                currentFile.languageVersion,
                true
            );
        }
    }

    return {
        changed: currentCode !== code,
        code: currentCode,
        sourceFile: currentFile
    };
};


export default { transform };
export type { CoordinatorResult };