import { PACKAGE_NAME } from './constants';


type Stop = (detail?: string) => void;


// `ESPORTSPLUS_TIMINGS=1` prints how long each phase of a build took, to stderr
const ENABLED = process.env.ESPORTSPLUS_TIMINGS !== undefined && process.env.ESPORTSPLUS_TIMINGS !== '0';

const IGNORE: Stop = () => {};


const timing = (label: string): Stop => {
    if (!ENABLED) {
        return IGNORE;
    }

    let start = performance.now();

    return (detail) => {
        console.error(`${PACKAGE_NAME}: ${label}${detail ? ' ' + detail : ''} in ${Math.round(performance.now() - start)} ms`);
    };
};


export default timing;
