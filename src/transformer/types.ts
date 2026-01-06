import type ts from 'typescript';


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

type TransformFn = (sourceFile: ts.SourceFile, program: ts.Program) => TransformResult;

type TransformResult = {
    changed: boolean;
    code: string;
    sourceFile: ts.SourceFile;
};

type VitePluginOptions = {
    name: string;
    onWatchChange?: () => void;
    transform: TransformFn;
};


export type { QuickCheckPattern, Range, Replacement, TransformFn, TransformResult, VitePluginOptions };
