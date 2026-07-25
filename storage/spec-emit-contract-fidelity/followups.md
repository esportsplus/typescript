# Follow-ups
- uid determinism: src/compiler/uid.ts mints a per-process uuid() namespace, so emitted identifiers differ on every build — non-reproducible output and broken content hashing. Fixing it changes the shape of a PUBLIC export (src/compiler/index.ts:6), so it is Ask-First and deliberately not an item in this spec.
- root export surface: src/index.ts is 'export {}' while package.json advertises '.' with types ./build/index.d.ts — the advertised root entry exports nothing. Confirm intent before changing; a public-API decision.
