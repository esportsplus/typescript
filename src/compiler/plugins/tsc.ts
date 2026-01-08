import type { Plugin } from '../types';


export default (plugins: Plugin[]) => {
    return () => plugins;
};
