const INVALID_CHARS = /[^A-Za-z0-9]/g;


let counter = 0;


function hash(str: string): string {
    let h = 0x811c9dc5;

    for (let i = 0, n = str.length; i < n; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }

    return ((h >>> 0).toString(36) + Math.abs(h).toString(36)).replace(INVALID_CHARS, '');
}


export default (prefix: string): string => {
    return prefix + '_' + hash(prefix) + (counter++).toString(36);
};