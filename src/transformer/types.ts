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


export type { QuickCheckPattern, Range, Replacement };
