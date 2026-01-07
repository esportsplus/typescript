import type ts from 'typescript';


type ImportIntent = {
    add?: string[];
    namespace?: string;
    package: string;
    remove?: string[];
};

type Plugin = {
    /**
     * Optional patterns for quick-check optimization.
     * If provided, transform() is only called when source contains at least one pattern.
     */
    patterns?: string[];

    /**
     * Transform a source file, returning replacement intents.
     * Called with fresh AST - positions are always accurate.
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
     * Generator function that produces the replacement text.
     * Called at apply-time with current sourceFile for accurate positions.
     */
    generate: (sourceFile: ts.SourceFile) => string;

    /**
     * AST node to replace. Position resolved at apply-time.
     */
    node: ts.Node;
};

type SharedContext = Map<string, unknown>;

type TransformContext = {
    checker: ts.TypeChecker;
    code: string;
    program: ts.Program;
    shared: SharedContext;
    sourceFile: ts.SourceFile;
};

type TransformResult = {
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
