import { uuid } from '@esportsplus/utilities';
import { UUID_REGEX } from './constants';


let cache = uuid().replace(UUID_REGEX, ''),
    i = 0;


export default (prefix: string, reset = false): string => {
    return prefix + '_' + (reset ? uuid().replace(UUID_REGEX, '') : cache) + (i++).toString(36);
};