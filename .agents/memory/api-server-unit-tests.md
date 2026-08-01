---
name: api-server unit tests
description: How to run node:test unit tests in artifacts/api-server (ts extension imports)
---
Rule: pure logic worth testing lives in `src/lib/*.ts` with a sibling `*.test.ts` (node:test + assert/strict). Run with `node --experimental-strip-types --test src/lib/<file>.test.ts`.
**Why:** ESM extensionless imports fail under node type-stripping; api-server tsconfig now sets `noEmit` + `allowImportingTsExtensions` (real build is esbuild via build.mjs), so tests import `./module.ts` with the extension.
**How to apply:** when adding server tests, import with the `.ts` extension and keep route handlers thin over testable lib functions.
