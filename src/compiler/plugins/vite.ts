import type { ResolvedConfig } from 'vite';
import type { Plugin, SharedContext } from '../types';
import { ts } from '~/index';
import coordinator from '../coordinator';
import program from '../program';


type VitePlugin = {
    configResolved: (config: unknown) => void;
    enforce: 'pre';
    name: string;
    transform: (code: string, id: string) => { code: string; map: null } | null;
    watchChange: (id: string) => void;
};

type VitePluginOptions = {
    name: string;
    onWatchChange?: () => void;
    plugins: Plugin[];
};


const FILE_REGEX = /\.[tj]sx?$/;

const DIRECTORY_SEPARATOR_REGEX = /\\/g;


let contexts = new Map<string, SharedContext>();


export default ({ name, onWatchChange, plugins }: VitePluginOptions) => {
    return ({ root }: { root?: string } = {}): VitePlugin => {
        return {
            configResolved(config: unknown) {
                root ??= (config as ResolvedConfig).root;
            },
            enforce: 'pre',
            name: `${name}/compiler/vite`,
            transform(code: string, id: string) {
                if (!FILE_REGEX.test(id) || id.includes('node_modules')) {
                    return null;
                }

                try {
                    let prog = program.get(root || ''),
                        sourceFile = prog.getSourceFile(id.replace(DIRECTORY_SEPARATOR_REGEX, '/')) || prog.getSourceFile(id);

                    if (!sourceFile || sourceFile.getText() !== code) {
                        sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
                    }

                    let result = coordinator.transform(
                            plugins,
                            code,
                            sourceFile,
                            prog,
                            contexts.get(root || '') ?? contexts.set(root || '', new Map()).get(root || '')!
                        );

                    if (!result.changed) {
                        return null;
                    }

                    return { code: result.code, map: null };
                }
                catch (error) {
                    console.error(`${name}: error transforming ${id}:`, error);
                    return null;
                }
            },
            watchChange(id: string) {
                if (FILE_REGEX.test(id)) {
                    onWatchChange?.();
                    contexts.delete(root || '');
                    program.delete(root || '');
                }
            }
        };
    };
};
