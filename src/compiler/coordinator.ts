import { isImportDeclaration, isNamedImports, isStringLiteral } from 'typescript/ast/is';
import { PACKAGE_NAME } from '../constants';
import type { Node, SourceFile } from 'typescript/ast';
import type { Checker, Program } from 'typescript/sync';
import type { ImportInfo, ModifyOptions } from './imports';
import type { OffsetAnchor, PositionMapping } from './sourcemap';
import type { ImportIntent, Plugin, Prepend, Replacement, ReplacementIntent, SharedContext, Text } from './types';

import checker from './checker';
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

// A replacement intent placed among the others by range: `children` are the intents inside it
type Intent = {
    // Whether its generator is running, so text() reads inside it rather than its replacement
    busy: boolean;
    children: Intent[];
    end: number;
    generate: ReplacementIntent['generate'];
    node: Node;
    // Plugin position, then intent position, deciding which of two equal ranges is the outer one
    order: number;
    plugin: number;
    start: number;
    text: string | null;
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


// First of `siblings` ending after `offset`: siblings are disjoint and sorted by start, so their
// ends ascend too
function after(siblings: Intent[], offset: number): number {
    let high = siblings.length,
        low = 0;

    while (low < high) {
        let middle = (low + high) >>> 1;

        if (siblings[middle].end <= offset) {
            low = middle + 1;
        }
        else {
            high = middle;
        }
    }

    return low;
}

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

// Every plugin's replacements against the one original source: contained ranges nest (on equal
// ranges an ancestor node, then a later plugin, is the outer one), and each intent generates with
// text(node) returning the node's source with every replacement nested inside it applied. Two ranges
// that overlap without nesting cannot both apply.
function compose(code: string, file: SourceFile, names: string[], intents: Intent[]): { edits: Replacement[]; text: Text } {
    intents.sort((a, b) => a.start - b.start || b.end - a.end || (encloses(a.node, b.node) ? -1 : encloses(b.node, a.node) ? 1 : b.order - a.order));

    let roots: Intent[] = [],
        stack: Intent[] = [];

    for (let i = 0, n = intents.length; i < n; i++) {
        let intent = intents[i];

        while (stack.length > 0) {
            let top = stack[stack.length - 1];

            if (contains(top, intent)) {
                break;
            }

            if (intent.start < top.end) {
                throw new Error(
                    `${PACKAGE_NAME}: replacements by ${names[top.plugin]} (${top.start}-${top.end}) and ${names[intent.plugin]} ` +
                    `(${intent.start}-${intent.end}) in ${file.fileName} overlap without one containing the other`
                );
            }

            stack.pop();
        }

        (stack.length > 0 ? stack[stack.length - 1].children : roots).push(intent);
        stack.push(intent);
    }

    let generate = (intent: Intent): string => {
        if (intent.text === null) {
            intent.busy = true;
            intent.text = intent.generate(file, text);
            intent.busy = false;
        }

        return intent.text;
    };

    let splice = (start: number, end: number, within: Intent[], parts: string[], at: number): number => {
        for (let i = after(within, start), n = within.length; i < n; i++) {
            let intent = within[i];

            if (intent.start >= end) {
                break;
            }

            if (intent.end <= start) {
                continue;
            }

            if (!intent.busy && intent.start >= start && intent.end <= end) {
                parts.push(code.slice(at, intent.start), generate(intent));
                at = intent.end;
            }
            else {
                at = splice(start, end, intent.children, parts, at);
            }
        }

        return at;
    };

    let text: Text = (node) => {
        let end = node.end,
            parts: string[] = [],
            start = node.getStart(file);

        parts.push(code.slice(splice(start, end, roots, parts, start), end));

        return parts.join('');
    };

    let edits: Replacement[] = [];

    for (let i = 0, n = roots.length; i < n; i++) {
        edits.push({ end: roots[i].end, newText: generate(roots[i]), start: roots[i].start });
    }

    return { edits, text };
}

// Whether `inner` lies within `outer`: inside its range, and not merely touching its end
function contains(outer: Intent, inner: Intent): boolean {
    return inner.start >= outer.start && inner.end <= outer.end && (inner.start < outer.end || outer.start === outer.end);
}

function encloses(ancestor: Node, node: Node): boolean {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent === ancestor) {
            return true;
        }
    }

    return false;
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


// True when at least one plugin could act on `code`. Every plugin analyses the original source, so
// when none matches it none runs: hosts use this to skip syncing the file into the language service.
const accepts = (plugins: Plugin[], code: string): boolean => {
    for (let i = 0, n = plugins.length; i < n; i++) {
        let patterns = plugins[i].patterns;

        if (!patterns || hasPattern(code, patterns)) {
            return true;
        }
    }

    return false;
};

// Every plugin analyses the same program and source and returns intents against that AST; their
// replacements compose in one generation (see compose), then each plugin's prepends (a function entry
// reading the composed text through text()) and imports apply in plugin order
const transform = (
    plugins: Plugin[],
    code: string,
    file: SourceFile,
    project: { checker: Checker; program: Program },
    root: string,
    shared: SharedContext
): CoordinatorResult => {
    if (plugins.length === 0) {
        return { changed: false, code, dependencies: [], map: { generations: [] } };
    }

    uid.scope(root, file.fileName, code);

    let changed = false,
        currentCode = code,
        dependencies = new Set<string>(),
        // currentCode is `outlined`'s text with `edited` applied in order; outline() and shift() follow it
        // so it is re-parsed only when they cannot
        edited: Replacement[][] = [],
        fileName = file.fileName,
        generations: OffsetAnchor[][] = [],
        intents: Intent[] = [],
        memoized = checker.cached(project.checker, project.program),
        names: string[] = [],
        outlined = file,
        steps: { imports: ImportIntent[]; prepend: Prepend[] }[] = [];

    let layout = (): Layout => {
        let result: Layout | null = outline(outlined);

        for (let i = 0, n = edited.length; i < n && result; i++) {
            result = shift(result, edited[i]);
        }

        if (!result) {
            outlined = languageService.parse(fileName, currentCode);
            edited = [];
            result = outline(outlined);
        }

        return result;
    };

    for (let i = 0, n = plugins.length; i < n; i++) {
        let plugin = plugins[i];

        names.push(plugin.name ?? `plugin #${i + 1}`);

        if (plugin.patterns && !hasPattern(code, plugin.patterns)) {
            continue;
        }

        let { dependencies: relied, imports, prepend, replacements } = plugin.transform({
                checker: memoized,
                code,
                program: project.program,
                shared,
                sourceFile: file
            });

        if (relied) {
            for (let j = 0, m = relied.length; j < m; j++) {
                dependencies.add(relied[j]);
            }
        }

        if (replacements) {
            for (let j = 0, m = replacements.length; j < m; j++) {
                let { generate, node } = replacements[j];

                intents.push({
                    busy: false,
                    children: [],
                    end: node.end,
                    generate,
                    node,
                    order: intents.length,
                    plugin: i,
                    start: node.getStart(file),
                    text: null
                });
            }
        }

        steps.push({ imports: imports?.length ? resolveImports(file, memoized, imports) : [], prepend: prepend ?? [] });
    }

    let { edits, text } = compose(code, file, names, intents);

    if (edits.length > 0) {
        generations.push(sourcemap.buildGeneration(code, edits));
        currentCode = replaceReverse(code, edits);
        edited.push(edits);
        changed = true;
    }

    for (let i = 0, n = steps.length; i < n; i++) {
        let { imports: importIntents, prepend } = steps[i];

        if (prepend.length > 0) {
            let before = currentCode,
                result = applyPrepend(currentCode, layout(), prepend.map(entry => typeof entry === 'string' ? entry : entry(text)));

            generations.push(sourcemap.buildGeneration(before, result.edits));
            currentCode = result.code;
            edited.push(result.edits);
            changed = true;
        }

        if (importIntents.length > 0) {
            let result = applyImports(currentCode, layout(), importIntents);

            for (let j = 0, m = result.batches.length; j < m; j++) {
                generations.push(sourcemap.buildGeneration(result.batches[j].before, result.batches[j].edits));
                edited.push(result.batches[j].edits);
            }

            currentCode = result.code;
            changed = true;
        }
    }

    return { changed, code: currentCode, dependencies: [...dependencies], map: { generations } };
};


export default { accepts, transform };
export type { CoordinatorResult };
