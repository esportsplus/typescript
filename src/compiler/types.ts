import type { Node, SourceFile } from 'typescript/unstable/ast';
import type { Checker, Program } from 'typescript/unstable/sync';


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
     */
    transform: (ctx: TransformContext) => TransformResult;
};

type PluginFactory = (options?: Record<string, unknown>) => Plugin;

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
    generate: (sourceFile: SourceFile, text: (node: Node) => string) => string;

    /**
     * AST node to replace. Position resolved at apply-time.
     */
    node: Node;
};

type SharedContext = Map<string, unknown>;

type TransformContext = {
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
     * Code to prepend after imports (e.g., generated classes, template factories).
     */
    prepend?: string[];

    /**
     * Replacement intents - node references with generator functions.
     */
    replacements?: ReplacementIntent[];
};


export type {
    ImportIntent,
    Plugin, PluginFactory,
    Range, Replacement, ReplacementIntent,
    SharedContext,
    TransformContext, TransformResult
};
