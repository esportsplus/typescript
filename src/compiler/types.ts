import type ts from 'typescript';


type AnalyzeFn = (sourceFile: ts.SourceFile, program: ts.Program, context: PluginContext) => void;

type PluginContext = Map<string, unknown>;

type PluginDefinition = {
    analyze?: AnalyzeFn;
    transform: TransformFn;
};

type QuickCheckPattern = {
    patterns?: string[];
    regex?: RegExp;
};

type Range = {
    end: number;
    start: number;
};

type Replacement = Range & {
    newText: string;
};

type TransformFn = (sourceFile: ts.SourceFile, program: ts.Program, context?: PluginContext) => TransformResult;

type TransformResult = {
    changed: boolean;
    code: string;
    sourceFile: ts.SourceFile;
};

type VitePluginOptions = {
    analyze?: AnalyzeFn;
    name: string;
    onWatchChange?: () => void;
    transform: TransformFn;
};


export type {
    AnalyzeFn,
    PluginContext, PluginDefinition,
    QuickCheckPattern,
    Range, Replacement,
    TransformFn, TransformResult,
    VitePluginOptions
};
