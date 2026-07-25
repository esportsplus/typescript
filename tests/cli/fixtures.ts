import fs from 'fs';
import path from 'path';


type FixtureOptions = {
    compilerOptions?: Record<string, unknown>;
    sources?: Record<string, string>;
    tsconfig?: Record<string, unknown>;
};


const BACKSLASH_REGEX = /\\/g;

const IMPORT_PLUGIN = 'export default { transform: () => ({ imports: [{ package: "~/runtime", add: ["helper"] }] }) };';

const MARKER_PLUGIN = 'export default { transform: () => ({ prepend: ["export const __TRANSFORMED__ = 42;"] }) };';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');


function collect(dir: string, base: string, results: string[]): void {
    let entries = fs.readdirSync(dir, { withFileTypes: true });

    for (let i = 0, n = entries.length; i < n; i++) {
        let entry = entries[i],
            full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            collect(full, base, results);
        }
        else {
            results.push(path.relative(base, full).replace(BACKSLASH_REGEX, '/'));
        }
    }
}

function createFixture(dir: string, options: FixtureOptions = {}): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'tsconfig.base.json'), path.join(dir, 'tsconfig.base.json'));
    fs.copyFileSync(path.join(REPO_ROOT, 'tsconfig.package.json'), path.join(dir, 'tsconfig.package.json'));

    let tsconfigPath = path.join(dir, 'tsconfig.json'),
        tsconfig = options.tsconfig ?? { compilerOptions: options.compilerOptions ?? {}, extends: './tsconfig.package.json' };

    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig));

    let sources = options.sources ?? {},
        entries = Object.entries(sources);

    for (let i = 0, n = entries.length; i < n; i++) {
        let [relativePath, content] = entries[i],
            target = path.join(dir, 'src', relativePath);

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }

    return tsconfigPath;
}

function snapshotTree(dir: string): string[] {
    let results: string[] = [];

    collect(dir, dir, results);

    return results.sort();
}


export { createFixture, IMPORT_PLUGIN, MARKER_PLUGIN, snapshotTree };
export type { FixtureOptions };
