export * from 'typescript/unstable/ast';
export * from 'typescript/unstable/sync';
// `ModifierFlags` is the only name both modules export; without an explicit winner the ambiguous
// star exports drop it entirely rather than erroring, so consumers lose it silently.
export { ModifierFlags } from 'typescript/unstable/ast';
