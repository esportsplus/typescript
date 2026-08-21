// The vended TypeScript surface: consumer packages depend on this helper instead of taking their own
// `typescript` dependency, so the compiler version is pinned in exactly one place.
export * as ts from './ts';
