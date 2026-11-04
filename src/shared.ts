import { fileURLToPath } from 'url';
import { PACKAGE_NAME } from './constants';

import fs from 'fs';
import path from 'path';


type Registration = {
    root: string;
    values: Map<string, unknown>;
    version: string;
};


const KEY = Symbol.for(`${PACKAGE_NAME}/shared`);


// This copy of the package: where it is installed and its exact version
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;


// One value per name for every copy of this package loaded in the process. Linked installs,
// worktrees and duplicated dependency ranges load a second copy; one of the same version shares the
// first one's state (the language service and its tsgo processes, the vite hosts' build state), one
// of another version cannot share it safely and fails instead of silently running beside it.
const shared = <T>(name: string, create: () => T): T => {
    let global = globalThis as { [KEY]?: Registration },
        registration = global[KEY];

    if (!registration) {
        registration = { root, values: new Map(), version };
        global[KEY] = registration;
    }
    else if (registration.version !== version) {
        throw new Error(
            `${PACKAGE_NAME}: two versions are loaded in one process, ${registration.version} from ${registration.root} ` +
            `and ${version} from ${root}; every package must resolve the same ${PACKAGE_NAME}`
        );
    }

    let value = registration.values.get(name) as T | undefined;

    if (value === undefined) {
        value = create();
        registration.values.set(name, value);
    }

    return value;
};


export default shared;
