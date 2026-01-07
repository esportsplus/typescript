import type { Plugin, SharedContext } from '../types.js';
import type ts from 'typescript';
import coordinator from '../coordinator.js';


type PluginInstance = {
    transform: ts.TransformerFactory<ts.SourceFile>;
};


export default (plugins: Plugin[]) => {
    return (program: ts.Program, shared: SharedContext): PluginInstance => {
        return {
            transform: (() => {
                return (sourceFile: ts.SourceFile) => {
                    let result = coordinator.transform(
                            plugins,
                            sourceFile.getFullText(),
                            sourceFile,
                            program,
                            shared
                        );

                    return result.changed ? result.sourceFile : sourceFile;
                };
            }) as ts.TransformerFactory<ts.SourceFile>
        };
    };
};
