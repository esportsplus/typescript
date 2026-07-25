import { defineConfig } from 'vitest/config';
import path from 'path';


export default defineConfig({
    resolve: {
        alias: {
            '~': path.resolve(__dirname, 'src')
        }
    },
    test: {
        benchmark: {
            include: ['bench/**/*.bench.ts']
        },
        include: ['test/**/*.test.ts']
    }
});
