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

const LINE_ENDINGS_REGEX = /\r\n/g;


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
                    let normalizedId = id.replace(DIRECTORY_SEPARATOR_REGEX, '/'),
                        prog = program.get(root || ''),
                        sourceFile = prog.getSourceFile(normalizedId) || prog.getSourceFile(id);

                    // Check if file content matches (existing file may have changed)
                    if (sourceFile && sourceFile.getText().replace(LINE_ENDINGS_REGEX, '\n') !== code.replace(LINE_ENDINGS_REGEX, '\n')) {
                        sourceFile = undefined;
                    }

                    if (!sourceFile) {
                        prog = coordinator.createPatchedProgram(prog, normalizedId, code);
                        sourceFile = prog.getSourceFile(normalizedId) || ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
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
