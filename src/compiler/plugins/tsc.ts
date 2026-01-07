import type { Plugin, SharedContext } from '../types';
import type ts from 'typescript';
import coordinator from '../coordinator';


export default (plugins: Plugin[]) => {
    return (program: ts.Program, shared: SharedContext) => {
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
