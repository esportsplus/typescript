import type { Plugin, SharedContext } from '../types';
import type { SourceMapV3 } from '../sourcemap';
import type { ResolvedConfig } from 'vite';

import coordinator from '../coordinator';
import languageService from '../language-service';
import sourcemap from '../sourcemap';


type VitePlugin = {
    closeBundle: () => void;
    closeWatcher: () => void;
    configResolved: (config: unknown) => void;
    enforce: 'pre';
    name: string;
    transform: (code: string, id: string) => { code: string; map: SourceMapV3 } | null;
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
            closeBundle() {
                languageService.dispose(root || '');
                contexts.delete(root || '');
            },
            closeWatcher() {
                languageService.dispose(root || '');
                contexts.delete(root || '');
            },
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
                        { checker, program } = languageService.update(root || '', normalizedId, code),
                        sourceFile = program.getSourceFile(normalizedId) ?? languageService.parse(normalizedId, code);

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
                            { checker, program },
                            key,
                            ctx
                        );

                    if (!result.changed) {
                        return null;
                    }

                    return { code: result.code, map: sourcemap.toSourceMapV3(result.map, result.code, code, normalizedId) };
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
