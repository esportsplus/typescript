import ts from 'typescript';


type ImportModification = {
    module: string;
    specifiers: Set<string>;
};

type NodeMatch<T> = {
    data: T;
    end: number;
    node: ts.Node;
    start: number;
};

type QuickCheckPattern = {
    patterns?: string[];
    regex?: RegExp;
};

type Replacement = {
    end: number;
    newText: string;
    start: number;
};

type VisitorCallback<T> = (node: ts.Node, state: T) => void;

type VisitorPredicate = (node: ts.Node) => boolean;


export type {
    ImportModification,
    NodeMatch,
    QuickCheckPattern,
    Replacement,
    VisitorCallback, VisitorPredicate
};