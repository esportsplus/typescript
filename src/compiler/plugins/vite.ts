import type { Plugin, SharedContext } from '../types';
import type { ResolvedConfig } from 'vite';
import { ts } from '~/index';

import coordinator from '../coordinator';
import languageService from '../language-service';


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


const DIRECTORY_SEPARATOR_REGEX = /\\/g;

const FILE_REGEX = /\.[tj]sx?$/;


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
                        prog = languageService.update(root || '', normalizedId, code),
                        sourceFile = prog.getSourceFile(normalizedId);

                    if (!sourceFile) {
                        sourceFile = ts.createSourceFile(normalizedId, code, ts.ScriptTarget.Latest, true);
                    }

                    let key = root || '',
                        ctx = contexts.get(key);

                    if (!ctx) {
                        ctx = new Map();
                        contexts.set(key, ctx);
                    }

                    let result = coordinator.transform(
                            plugins,
                            code,
                            sourceFile,
                            prog,
                            key,
                            ctx
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
                    languageService.invalidate(root || '', id);
                }
            }
        };
    };
};
