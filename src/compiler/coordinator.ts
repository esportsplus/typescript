import type { SourceFile } from 'typescript/unstable/ast';
import type { Checker, Program } from 'typescript/unstable/sync';
import type { ImportIntent, Plugin, Replacement, ReplacementIntent, SharedContext } from './types';
import type { ModifyOptions } from './imports';
import { isImportDeclaration } from 'typescript/unstable/ast/is';

import type { OffsetAnchor, PositionMapping } from './sourcemap';

import imports from './imports';
import languageService from './language-service';
import sourcemap from './sourcemap';
import uid from './uid';


type CoordinatorResult = {
    changed: boolean;
    code: string;
    map: PositionMapping;
    sourceFile: SourceFile;
};

type EditBatch = {
    before: string;
    edits: Replacement[];
};


function applyImports(code: string, file: SourceFile, intents: ImportIntent[]): { batches: EditBatch[]; code: string } {
    let merged = new Map<string, { add?: string[]; namespace?: string; remove?: string[] }>();

    for (let i = 0, n = intents.length; i < n; i++) {
        let intent = intents[i],
            existing = merged.get(intent.package);

        if (existing) {
            if (intent.add) {
                (existing.add ??= []).push(...intent.add);
            }
            if (intent.namespace) {
                existing.namespace = intent.namespace;
            }
            if (intent.remove) {
                (existing.remove ??= []).push(...intent.remove);
            }
        }
        else {
            merged.set(intent.package, {
                add: intent.add ? [...intent.add] : undefined,
                namespace: intent.namespace,
                remove: intent.remove ? [...intent.remove] : undefined
            });
        }
    }

    let batches: EditBatch[] = [],
        keys = [...merged.keys()];

    for (let i = 0, n = keys.length; i < n; i++) {
        let before = code,
            result = modify(code, file, keys[i], merged.get(keys[i])!);

        code = result.code;

        if (result.edits.length > 0) {
            batches.push({ before, edits: result.edits });
        }

        if (i < n - 1) {
            file = languageService.parse(file.fileName, code);
        }
    }

    return { batches, code };
}

function applyIntents(code: string, file: SourceFile, intents: ReplacementIntent[]): { code: string; edits: Replacement[] } {
    if (intents.length === 0) {
        return { code, edits: [] };
    }

    let edits = intents.map(intent => ({
        end: intent.node.end,
        newText: intent.generate(file),
        start: intent.node.getStart(file)
    }));

    return { code: replaceReverse(code, edits), edits };
}

function applyPrepend(code: string, file: SourceFile, prepend: string[]): { code: string; edits: Replacement[] } {
    if (prepend.length === 0) {
        return { code, edits: [] };
    }

    let position = 0;

    for (let i = 0, n = file.statements.length; i < n; i++) {
        let stmt = file.statements[i];

        if (isImportDeclaration(stmt)) {
            position = stmt.end;
        }
        else {
            break;
        }
    }

    if (position === 0) {
        let newText = prepend.join('\n') + '\n';

        return { code: newText + code, edits: [{ end: 0, newText, start: 0 }] };
    }

    let newText = '\n' + prepend.join('\n') + '\n';

    return { code: code.slice(0, position) + newText + code.slice(position), edits: [{ end: position, newText, start: position }] };
}

function hasPattern(code: string, patterns: string[]): boolean {
    for (let i = 0, n = patterns.length; i < n; i++) {
        if (code.indexOf(patterns[i]) !== -1) {
            return true;
        }
    }

    return false;
}

function modify(code: string, file: SourceFile, pkg: string, options: ModifyOptions): { code: string; edits: Replacement[] } {
    if (!options.add && !options.namespace && !options.remove) {
        return { code, edits: [] };
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
            return { code, edits: [] };
        }

        let newText = statements.join('\n') + '\n';

        return { code: newText + code, edits: [{ end: 0, newText, start: 0 }] };
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

    return { code: replaceReverse(code, replacements), edits: replacements };
}

function replaceReverse(code: string, replacements: Replacement[]): string {
    if (replacements.length === 0) {
        return code;
    }

    replacements.sort((a, b) => b.start - a.start);

    let parts: string[] = [],
        pos = code.length;

    for (let i = 0, n = replacements.length; i < n; i++) {
        let r = replacements[i];

        if (r.end < pos) {
            parts.push(code.substring(r.end, pos));
        }

        parts.push(r.newText);
        pos = r.start;
    }

    if (pos > 0) {
        parts.push(code.substring(0, pos));
    }

    return parts.reverse().join('');
}


const transform = (
    plugins: Plugin[],
    code: string,
    file: SourceFile,
    project: { checker: Checker; program: Program },
    root: string,
    shared: SharedContext
) => {
    if (plugins.length === 0) {
        return { changed: false, code, map: { generations: [] }, sourceFile: file };
    }

    uid.scope(root, file.fileName, code);

    let changed = false,
        currentCode = code,
        currentFile = file,
        currentProject = project,
        fileName = file.fileName,
        generations: OffsetAnchor[][] = [],
        last = plugins.length - 1;

    for (let i = 0, n = plugins.length; i < n; i++) {
        let plugin = plugins[i];

        if (plugin.patterns && !hasPattern(currentCode, plugin.patterns)) {
            continue;
        }

        let { imports, prepend, replacements } = plugin.transform({
                checker: currentProject.checker,
                code: currentCode,
                program: currentProject.program,
                shared,
                sourceFile: currentFile
            }),
            pluginChanged = false;

        if (replacements?.length) {
            let before = currentCode,
                result = applyIntents(currentCode, currentFile, replacements);

            if (result.edits.length > 0) {
                generations.push(sourcemap.buildGeneration(before, result.edits));
            }

            currentCode = result.code;
            pluginChanged = true;
        }

        if (prepend?.length) {
            if (pluginChanged) {
                currentFile = languageService.parse(fileName, currentCode);
            }

            let before = currentCode,
                result = applyPrepend(currentCode, currentFile, prepend);

            if (result.edits.length > 0) {
                generations.push(sourcemap.buildGeneration(before, result.edits));
            }

            currentCode = result.code;
            pluginChanged = true;
        }

        if (imports?.length) {
            if (pluginChanged) {
                currentFile = languageService.parse(fileName, currentCode);
            }

            let result = applyImports(currentCode, currentFile, imports);

            for (let j = 0, m = result.batches.length; j < m; j++) {
                generations.push(sourcemap.buildGeneration(result.batches[j].before, result.batches[j].edits));
            }

            currentCode = result.code;
            pluginChanged = true;
        }

        if (pluginChanged) {
            changed = true;

            if (i < last) {
                currentProject = languageService.update(root, fileName, currentCode);
                currentFile = currentProject.program.getSourceFile(fileName) ??
                    languageService.parse(fileName, currentCode);
            }
            else {
                currentFile = languageService.parse(fileName, currentCode);
            }
        }
    }

    return { changed, code: currentCode, map: { generations }, sourceFile: currentFile };
};


export default { transform };
export type { CoordinatorResult };