import ts from 'typescript';


type ImportModification = {
    module: string;
    specifiers: Set<string>;
};

type NodeMatch<T> = Range & {
    data: T;
    node: ts.Node;
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

type VisitorCallback<T> = (node: ts.Node, state: T) => void;

type VisitorPredicate = (node: ts.Node) => boolean;


export type {
    ImportModification,
    NodeMatch,
    QuickCheckPattern,
    Range, Replacement,
    VisitorCallback, VisitorPredicate
};