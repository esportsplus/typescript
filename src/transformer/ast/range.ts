type Range = {
    end: number;
    start: number;
};


const containsPosition = (range: Range, pos: number): boolean => {
    return pos >= range.start && pos <= range.end;
}

const inRange = (ranges: Range[], start: number, end: number): boolean => {
    for (let i = 0, n = ranges.length; i < n; i++) {
        let r = ranges[i];

        if (start >= r.start && end <= r.end) {
            return true;
        }
    }

    return false;
}


export { containsPosition, inRange };
export type { Range };
