function lineOfPosition(lineStarts: readonly number[], position: number): number {
    let high = lineStarts.length - 1,
        low = 0;

    while (low <= high) {
        let middle = (low + high) >> 1;

        if (lineStarts[middle] <= position) {
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }

    return high < 0 ? 0 : high;
}

export { lineOfPosition };
