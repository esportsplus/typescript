import type { TransformFn } from '../types';
import { ts } from '../..';


export default (transform: TransformFn): (program: ts.Program) => ts.TransformerFactory<ts.SourceFile> => {
    return (program) => {
        return () => {
            return (sourceFile) => {
                let result = transform(sourceFile, program);

                return result.changed ? result.sourceFile : sourceFile;
            };
        };
    };
}
