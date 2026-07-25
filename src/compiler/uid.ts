import path from 'path';


const BACKSLASH_REGEX = /\\/g;

const FNV_OFFSET_BASIS = 2166136261;

const FNV_PRIME = 16777619;

const NAMESPACE_WIDTH = 7;

const UNSCOPED_NAMESPACE = 'u';


let counter = 0,
    namespace = UNSCOPED_NAMESPACE;


function derive(id: string, code: string): string {
    let candidate = format(id),
        salt = 0;

    while (code.includes(candidate)) {
        salt++;
        candidate = format(id + '#' + salt);
    }

    return candidate;
}

function format(id: string): string {
    return hash(id).toString(36).padStart(NAMESPACE_WIDTH, '0');
}

function hash(value: string): number {
    let h = FNV_OFFSET_BASIS;

    for (let i = 0, n = value.length; i < n; i++) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, FNV_PRIME);
    }

    return h >>> 0;
}


const uid = (name: string): string => {
    return name + '_' + namespace + (counter++).toString(36);
};

// Every generated id embeds `namespace`, so proving the namespace absent from the file once makes all of them collision-free.
uid.scope = (root: string, fileName: string, code: string): void => {
    counter = 0;
    namespace = derive(path.relative(root, fileName).replace(BACKSLASH_REGEX, '/') || fileName, code);
};


export default uid;
