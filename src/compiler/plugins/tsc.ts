import type { PluginContext, PluginDefinition } from '../types';
import { ts } from '../..';


export default ({ analyze, transform }: PluginDefinition) => {
    return (program: ts.Program, context: PluginContext) => {
        return {
            analyze: analyze
                ? (sourceFile: ts.SourceFile) => analyze(sourceFile, program, context)
                : undefined,
            transform: (() => {
                return (sourceFile) => {
                    let result = transform(sourceFile, program, context);

                    return result.changed ? result.sourceFile : sourceFile;
                };
            }) as ts.TransformerFactory<ts.SourceFile>
        };
    };
}
