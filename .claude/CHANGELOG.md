# Changelog

## Completed
- abandoned spend: ~$13.78 equivalent API cost across 10 terminal non-COMPLETED item(s) (baseline-regression-gate, types-plugin-contract, language-service-api-lifecycle, ast-unstable-guards, imports-node-handles, coordinator-api-reparse, cli-tsgo-emit, vite-plugin-lifecycle, root-export-surface, build-green-gate); recorded, not divided into per-item costs (run 3c1d531f)
- run-level spend: ~$0.00 equivalent API cost (warm implementer runs + unit-scoped + boundary seats; never divided across items; blended rate = mean(input, output, cache_read, cache_creation) per million tokens) (run 3c1d531f)
- cost source of truth: ccusage per-model breakdown (local transcripts carry the input/output/cache split the run journal does not) — figures above are a blended-rate approximation per contracts/models.json pricing (run 3c1d531f)
