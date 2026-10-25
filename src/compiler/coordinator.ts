import type { SourceFile } from 'typescript/unstable/ast';
import type { Checker, Program } from 'typescript/unstable/sync';
import type { ImportIntent, Plugin, Replacement, ReplacementIntent, SharedContext } from './types';
import type { ImportInfo, ModifyOptions } from './imports';
import { isImportDeclaration, isNamedImports, isStringLiteral } from 'typescript/unstable/ast/is';

import type { OffsetAnchor, PositionMapping } from './sourcemap';

import imports from './imports';
import languageService from './language-service';
import sourcemap from './sourcemap';
import uid from './uid';


type CoordinatorResult = {
    changed: boolean;
    code: string;
    dependencies: string[];
    map: PositionMapping;
};

type EditBatch = {
    before: string;
    edits: Replacement[];
};

// What applyPrepend and modify() read from a file: its import declarations and where the run of them
// opening the file ends
type Layout = {
    // Start of the first statement that is not an import declaration; the text's length when none is
    boundary: number;
    declarations: { info: ImportInfo; module: string | null }[];
    // End of the last import declaration before any other statement; 0 when none opens the file
    leading: number;
};


// An `import` that is not a call or `import.meta`: text that may declare an import
const IMPORT_DECLARATION = /\bimport\b(?!\s*[(.])/;


function applyImports(code: string, layout: Layout, intents: ImportIntent[]): { batches: EditBatch[]; code: string } {
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

    let edits: Replacement[] = [],
        keys = [...merged.keys()];

    for (let i = 0, n = keys.length; i < n; i++) {
        let found: ImportInfo[] = [];

        for (let j = 0, m = layout.declarations.length; j < m; j++) {
            if (layout.declarations[j].module === keys[i]) {
                found.push(layout.declarations[j].info);
            }
        }

        edits.push(...modify(code, found, keys[i], merged.get(keys[i])!).edits);
    }

    if (edits.length === 0) {
        return { batches: [], code };
    }

    return { batches: [{ before: code, edits }], code: replaceReverse(code, edits) };
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

function applyPrepend(code: string, layout: Layout, prepend: string[]): { code: string; edits: Replacement[] } {
    if (prepend.length === 0) {
        return { code, edits: [] };
    }

    let position = layout.leading;

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

function modify(code: string, found: ImportInfo[], pkg: string, options: ModifyOptions): { code: string; edits: Replacement[] } {
    if (!options.add && !options.namespace && !options.remove) {
        return { code, edits: [] };
    }

    let { namespace } = options,
        add = options.add ? new Set(options.add) : null;

    if (namespace && !add && !options.remove && found.some(info => info.namespace === namespace)) {
        return { code, edits: [] };
    }

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
        specifiers = new Set<string>(),
        nonNamespace = found.filter(info => !info.namespace),
        existingNamespace = found.some(info => info.namespace === namespace),
        defaultImport = nonNamespace.find(info => info.defaultName),
        target = defaultImport ?? nonNamespace[0];

    for (let i = 0, n = found.length; i < n; i++) {
        for (let [name, alias] of found[i].specifiers) {
            if (!remove || (!remove.has(name) && !remove.has(alias))) {
                let base = name === alias ? name : `${name} as ${alias}`;

                // Preserve type-only specifiers with an inline `type` modifier so the merged import
                // stays erasable — otherwise `import type { X }` re-emits as a runtime `import { X }`
                // and fails at load time when X has no runtime export.
                specifiers.add(found[i].typeOnly.has(name) ? `type ${base}` : base);
            }
        }
    }

    if (add) {
        for (let name of add) {
            specifiers.add(name);
        }
    }

    let statements: string[] = [];

    if (namespace && !existingNamespace) {
        statements.push(`import * as ${namespace} from '${pkg}';`);
    }

    if (target) {
        let named = specifiers.size > 0 ? `{ ${[...specifiers].sort().join(', ')} }` : '',
            defaultName = target.defaultName,
            clause = defaultName && named ? `${defaultName}, ${named}` : defaultName ?? named;

        if (clause) {
            statements.push(`import ${clause} from '${pkg}';`);
        }
    }
    else if (specifiers.size > 0) {
        statements.push(`import { ${[...specifiers].sort().join(', ')} } from '${pkg}';`);
    }

    let replacements: Replacement[] = [];

    for (let i = 0, n = found.length; i < n; i++) {
        let info = found[i];

        if (info.namespace) {
            continue;
        }

        replacements.push({
            end: info.end,
            newText: info === target ? statements.join('\n') : info.defaultName ? `import ${info.defaultName} from '${pkg}';` : '',
            start: info.start
        });
    }

    if (!target && statements.length > 0) {
        let first = found[0];

        replacements.push({ end: first.start, newText: statements.join('\n') + '\n', start: first.start });
    }

    return { code: replaceReverse(code, replacements), edits: replacements };
}

function outline(file: SourceFile): Layout {
    let boundary = file.text.length,
        declarations: Layout['declarations'] = [],
        leading = 0,
        opening = true;

    for (let i = 0, n = file.statements.length; i < n; i++) {
        let statement = file.statements[i];

        if (!isImportDeclaration(statement)) {
            if (opening) {
                boundary = statement.getStart(file);
                opening = false;
            }

            continue;
        }

        if (opening) {
            leading = statement.end;
        }

        declarations.push({
            info: imports.describe(file, statement),
            module: isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null
        });
    }

    return { boundary, declarations, leading };
}

function replaceReverse(code: string, replacements: Replacement[]): string {
    if (replacements.length === 0) {
        return code;
    }

    replacements.sort((a, b) => b.start - a.start || b.end - a.end);

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

// The layout once `edits` (against the layout's text) are applied, without re-parsing. Null when an edit could
// change what a parse finds: one reaching the opening imports or the first other statement (whose first
// token decides its kind), one overlapping an import declaration, or text that may declare an import. The
// one edit allowed before the boundary is a prepend's insertion at the end of the opening imports.
function shift(layout: Layout, edits: Replacement[]): Layout | null {
    let boundary = layout.boundary;

    for (let i = 0, n = edits.length; i < n; i++) {
        let edit = edits[i];

        if (IMPORT_DECLARATION.test(edit.newText)) {
            return null;
        }

        if (edit.start === edit.end && edit.start === layout.leading) {
            boundary = Math.min(boundary, edit.start);
            continue;
        }

        if (edit.start <= layout.boundary) {
            return null;
        }

        for (let j = 0, m = layout.declarations.length; j < m; j++) {
            let { info } = layout.declarations[j];

            if (edit.start < info.end && edit.end > info.start) {
                return null;
            }
        }
    }

    let declarations: Layout['declarations'] = [];

    for (let i = 0, n = layout.declarations.length; i < n; i++) {
        let declaration = layout.declarations[i],
            delta = 0;

        for (let j = 0, m = edits.length; j < m; j++) {
            let edit = edits[j];

            if (edit.end <= declaration.info.start) {
                delta += edit.newText.length - (edit.end - edit.start);
            }
        }

        declarations.push(delta === 0 ? declaration : {
            info: { ...declaration.info, end: declaration.info.end + delta, start: declaration.info.start + delta },
            module: declaration.module
        });
    }

    return { boundary, declarations, leading: layout.leading };
}

function resolveImports(file: SourceFile, checker: Checker, intents: ImportIntent[]): ImportIntent[] {
    let resolved = [...intents];

    for (let i = 0, n = intents.length; i < n; i++) {
        let intent = intents[i];

        if (!intent.remove?.length) {
            continue;
        }

        let remove = new Set(intent.remove);

        for (let statement of file.statements) {
            if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text === intent.package) {
                continue;
            }

            let bindings = statement.importClause?.namedBindings;

            if (!bindings || !isNamedImports(bindings)) {
                continue;
            }

            let names: string[] = [];

            for (let element of bindings.elements) {
                let name = element.name.text;

                if ((remove.has(name) || remove.has(element.propertyName?.text ?? name)) && imports.includes(checker, element.name, intent.package)) {
                    names.push(name);
                }
            }

            if (names.length > 0) {
                resolved.push({ package: statement.moduleSpecifier.text, remove: names });
            }
        }
    }

    return resolved;
}


// True when at least one plugin could act on `code`. Plugins run in order on each other's output,
// so if none matches the original source, none ever runs: hosts use this to skip syncing the file
// into the language service at all.
const accepts = (plugins: Plugin[], code: string): boolean => {
    for (let i = 0, n = plugins.length; i < n; i++) {
        let patterns = plugins[i].patterns;

        if (!patterns || hasPattern(code, patterns)) {
            return true;
        }
    }

    return false;
};

const transform = (
    plugins: Plugin[],
    code: string,
    file: SourceFile,
    project: { checker: Checker; configPath?: string; program: Program },
    root: string,
    shared: SharedContext
): CoordinatorResult => {
    if (plugins.length === 0) {
        return { changed: false, code, dependencies: [], map: { generations: [] } };
    }

    uid.scope(root, file.fileName, code);

    let changed = false,
        configPath = project.configPath ?? languageService.findConfig(root) ?? root,
        dependencies = new Set<string>(),
        currentCode = code,
        currentFile = file,
        currentProject = project,
        fileName = file.fileName,
        generations: OffsetAnchor[][] = [],
        last = plugins.length - 1,
        // currentCode is `outlined`'s text with `edited` applied in order; outline() and shift() follow it
        // between a plugin's steps so it is re-parsed only when they cannot
        edited: Replacement[][] = [],
        outlined = currentFile,
        staged = false;

    let layout = (): Layout => {
        let result: Layout | null = outline(outlined);

        for (let i = 0, n = edited.length; i < n && result; i++) {
            result = shift(result, edited[i]);
        }

        if (!result) {
            currentFile = outlined = languageService.parse(fileName, currentCode);
            edited = [];
            result = outline(outlined);
        }

        return result;
    };

    for (let i = 0, n = plugins.length; i < n; i++) {
        let plugin = plugins[i];

        if (plugin.patterns && !hasPattern(currentCode, plugin.patterns)) {
            continue;
        }

        let { dependencies: relied, imports, prepend, replacements } = plugin.transform({
                checker: currentProject.checker,
                code: currentCode,
                program: currentProject.program,
                shared,
                sourceFile: currentFile
            }),
            importIntents = imports?.length ? resolveImports(currentFile, currentProject.checker, imports) : [],
            pluginChanged = false;

        if (relied) {
            for (let j = 0, m = relied.length; j < m; j++) {
                dependencies.add(relied[j]);
            }
        }

        if (replacements?.length) {
            let before = currentCode,
                result = applyIntents(currentCode, currentFile, replacements);

            if (result.edits.length > 0) {
                generations.push(sourcemap.buildGeneration(before, result.edits));
            }

            currentCode = result.code;
            edited.push(result.edits);
            pluginChanged = true;
        }

        if (prepend?.length) {
            let before = currentCode,
                result = applyPrepend(currentCode, layout(), prepend);

            if (result.edits.length > 0) {
                generations.push(sourcemap.buildGeneration(before, result.edits));
            }

            currentCode = result.code;
            edited.push(result.edits);
            pluginChanged = true;
        }

        if (importIntents.length > 0) {
            let result = applyImports(currentCode, layout(), importIntents);

            for (let j = 0, m = result.batches.length; j < m; j++) {
                generations.push(sourcemap.buildGeneration(result.batches[j].before, result.batches[j].edits));
                edited.push(result.batches[j].edits);
            }

            currentCode = result.code;
            pluginChanged = true;
        }

        if (pluginChanged) {
            changed = true;

            // Later plugins check the intermediate output on a staged program: the project's own
            // program is shared by every file the host transforms, and a later file that imports
            // this one must see its source
            if (i < last) {
                if (!staged) {
                    languageService.update(configPath, fileName, code);
                    staged = true;
                }

                currentProject = languageService.stage(configPath, fileName, currentCode);
                currentFile = outlined = currentProject.program.getSourceFile(fileName) ??
                    languageService.parse(fileName, currentCode);
                edited = [];
            }
        }
    }

    return { changed, code: currentCode, dependencies: [...dependencies], map: { generations } };
};


export default { accepts, transform };
export type { CoordinatorResult };
