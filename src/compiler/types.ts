import type { Node, SourceFile } from 'typescript/ast';
import type { Checker, Program } from 'typescript/async';


type ImportIntent = {
    add?: string[];
    namespace?: string;
    package: string;
    remove?: string[];
};

type Plugin = {
    /**
     * Names the plugin in coordinator errors (e.g. two plugins' replacements overlapping).
     */
    name?: string;

    /**
     * Optional patterns for quick-check optimization.
     * If provided, transform() is only called when the original source contains at least one pattern.
     */
    patterns?: string[];

    /**
     * Transform a source file, returning intents against its AST. Every plugin receives the same
     * original program and source file; the coordinator composes all of their replacements.
     * Hosts transform many files concurrently: await checker queries rather than chaining them,
     * and ask for everything a step needs at once (one request per turn), not one by one.
     */
    transform: (ctx: TransformContext) => Promise<TransformResult>;
};

type PluginFactory = (options?: Record<string, unknown>) => Plugin;

// A prepended statement, or one generated from the composed source once every replacement applied
type Prepend = string | ((text: Text) => string);

type Range = {
    end: number;
    start: number;
};

type Replacement = Range & {
    newText: string;
};

type ReplacementIntent = {
    /**
     * Produces the replacement text. `text(node)` is the node's source with every replacement
     * nested inside it (from any plugin, or this plugin's other intents) already applied; use it
     * instead of `node.getText()` for any expression copied into the output.
     */
    generate: (sourceFile: SourceFile, text: Text) => string;

    /**
     * AST node to replace. Position resolved at apply-time.
     */
    node: Node;
};

type SharedContext = Map<string, unknown>;

// A node's source with every replacement nested inside it applied
type Text = (node: Node) => string;

type TransformContext = {
    /**
     * This transform's view of the program's checker: answers are shared with every concurrent
     * transform of the program, a query in flight is awaited rather than sent again, and the
     * queries missed in one turn go to tsgo as one request.
     */
    checker: Checker;
    code: string;
    program: Program;
    shared: SharedContext;
    sourceFile: SourceFile;
};

type TransformResult = {
    /**
     * Files outside this one whose declarations the transform relied on (e.g. an Origin's declaration and `through` files).
     * Hosts re-run this file's transform when one of them changes.
     */
    dependencies?: string[];

    /**
     * Import modifications to apply after replacements.
     */
    imports?: ImportIntent[];

    /**
     * Virtual modules this file's compile emits: the id its output imports (`import('virtual:x')`)
     * to the module's code. The host serves them (`resolveId`/`load`) while this file's result
     * stands, keeps them with a reused result, and drops them when the file is compiled again or
     * changes; use this instead of a registry of your own, which a reused result would leave empty.
     */
    modules?: Map<string, string>;

    /**
     * Code to prepend after imports (e.g., generated classes, template factories). Applied after
     * every plugin's replacements are composed, in plugin order, then that plugin's imports; a
     * function entry is called then with `text()` (the same helper `generate` receives), so it can
     * read sources other plugins rewrote and anything its own generators recorded.
     */
    prepend?: Prepend[];

    /**
     * Replacement intents - node references with generator functions.
     */
    replacements?: ReplacementIntent[];

    /**
     * Warnings about the source, in order. The host reports them on every transform of the file,
     * a result reused from its caches included, so a plugin must return them rather than report
     * them itself.
     */
    warnings?: Warning[];
};

type Warning = {
    message: string;

    /**
     * Offset into the original source the warning is about (e.g. `node.getStart(sourceFile)`);
     * the host reports it as file:line:column.
     */
    position?: number;
};


export type {
    ImportIntent,
    Plugin, PluginFactory, Prepend,
    Range, Replacement, ReplacementIntent,
    SharedContext,
    Text, TransformContext, TransformResult,
    Warning
};
