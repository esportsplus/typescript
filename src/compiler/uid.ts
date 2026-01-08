import { uuid } from '@esportsplus/utilities';


let i = 0,
    namespace = uuid().replace(/[^A-Za-z0-9]/g, '');


export default (name: string): string => {
    return name + '_' + namespace + (i++).toString(36);
};