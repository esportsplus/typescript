type Range = {
    end: number;
    start: number;
};


const inRange = (ranges: Range[], start: number, end: number): boolean => {
    for (let i = 0, n = ranges.length; i < n; i++) {
        let r = ranges[i];

        if (start >= r.start && end <= r.end) {
            return true;
        }
    }

    return false;
};


export { inRange };
export type { Range };
