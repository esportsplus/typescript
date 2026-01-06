import type { ResolvedConfig } from 'vite';
import type { VitePluginOptions } from '../types';
import { ts } from '../..';
import program from '../program';


const FILE_REGEX = /\.[tj]sx?$/;


export default ({ name, onWatchChange, transform }: VitePluginOptions) => {
    return ({ root }: { root?: string } = {}) => {
        return {
            configResolved(config: ResolvedConfig) {
                root ??= config.root;
            },
            enforce: 'pre',
            name: `${name}/plugin-vite`,
            transform(code: string, id: string) {
                if (!FILE_REGEX.test(id) || id.includes('node_modules')) {
                    return null;
                }

                try {
                    let result = transform(
                            ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true),
                            program.get(root || '')
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
                    program.delete(root || '');
                }
            }
        };
    };
};
