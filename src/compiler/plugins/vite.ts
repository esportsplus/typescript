import type { ResolvedConfig } from 'vite';
import type { AnalyzeFn, PluginContext, TransformFn } from '../types';
import { ts } from '../..';
import program from '../program';


type VitePlugin = {
    configResolved: (config: unknown) => void;
    enforce: 'pre';
    name: string;
    transform: (code: string, id: string) => { code: string; map: null } | null;
    watchChange: (id: string) => void;
};

type VitePluginOptions = {
    analyze?: AnalyzeFn;
    name: string;
    onWatchChange?: () => void;
    transform: TransformFn;
};


const FILE_REGEX = /\.[tj]sx?$/;


let contexts = new Map<string, PluginContext>();


export default ({ analyze, name, onWatchChange, transform }: VitePluginOptions) => {
    return ({ root }: { root?: string } = {}): VitePlugin => {
        return {
            configResolved(config: unknown) {
                root ??= (config as ResolvedConfig).root;
            },
            enforce: 'pre',
            name: `${name}/plugin-vite`,
            transform(code: string, id: string) {
                if (!FILE_REGEX.test(id) || id.includes('node_modules')) {
                    return null;
                }

                try {
                    let context = contexts.get(root || '') ?? contexts.set(root || '', new Map()).get(root || '')!,
                        prog = program.get(root || ''),
                        sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);

                    analyze?.(sourceFile, prog, context);

                    let result = transform(sourceFile, prog, context);

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
