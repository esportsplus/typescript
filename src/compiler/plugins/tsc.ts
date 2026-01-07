import type { PluginContext, PluginDefinition } from '../types';
import { ts } from '../..';


type TscPluginFactory = (program: ts.Program, context: PluginContext) => {
    analyze?: (sourceFile: ts.SourceFile) => void;
    transform: ts.TransformerFactory<ts.SourceFile>;
};


export default ({ analyze, transform }: PluginDefinition): TscPluginFactory => {
    return (program: ts.Program, context: PluginContext) => {
        return {
            analyze: analyze
                ? (sourceFile: ts.SourceFile) => analyze(sourceFile, program, context)
                : undefined,
            transform: () => {
                return (sourceFile) => {
                    let result = transform(sourceFile, program, context);

                    return result.changed ? result.sourceFile : sourceFile;
                };
            }
        };
    };
}
