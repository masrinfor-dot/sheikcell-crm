---
name: api-server unit tests
description: How to run node:test unit tests in artifacts/api-server (ts extension imports)
---
Rule: pure logic worth testing lives in `src/lib/*.ts` with a sibling `*.test.ts` (node:test + assert/strict). Run with `node --experimental-strip-types --test src/lib/<file>.test.ts`.
**Why:** ESM extensionless imports fail under node type-stripping; api-server tsconfig now sets `noEmit` + `allowImportingTsExtensions` (real build is esbuild via build.mjs), so tests import `./module.ts` with the extension.
**How to apply:** when adding server tests, import with the `.ts` extension and keep route handlers thin over testable lib functions.

## Migrations are NOT applied by the test harness

`app.ts` (imported by every `*.test.ts` and by `tenantIsolation.test.ts`) never
calls `runMigrations()` — that only happens in `index.ts` at real server boot.
The dev Postgres the tests hit (`postgres://sheikcell:sheikcell123@localhost:5432/sheikcell`)
only has whatever migrations were applied by an actual server run in the past.

**Why:** hit this repeatedly in one session — added a new migration (schema
change), ran the test suite, got a genuine-looking `relation ... does not
exist` / `column ... does not exist` failure that had nothing to do with the
code being wrong.

**How to apply:** after adding a new `migrations/NNNN_*.sql` file (and
registering it in `lib/migrate.ts`'s `MIGRATION_FILES`), apply it to the dev
DB by hand before trusting any test run against it — e.g. a small inline
script with `pg`'s `Client` reading and executing the SQL file directly (run
from `artifacts/api-server` so the `pg` dependency resolves). Don't spend time
debugging a "missing column" test failure as if it were a logic bug first —
check `information_schema.columns`/`to_regclass` for the new table/column.
