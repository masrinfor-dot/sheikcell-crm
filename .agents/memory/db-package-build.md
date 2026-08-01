---
name: db package needs tsc -b after schema edits
description: lib/db uses TS project references with emitted dist/ d.ts; editing schema without rebuilding makes dependents' typecheck fail
---
Rule: after editing any file in `lib/db/src/schema/`, run `npx tsc -b lib/db` (from repo root) before typechecking api-server/web, or new columns appear "missing".

**Why:** api-server/web reference lib/db as a TS project reference and resolve types from its emitted `dist/` declarations, not `src/`. Stale dist ⇒ TS2339/TS2353 on freshly added columns despite correct source.

**How to apply:** schema change → rebuild lib/db → `pnpm --filter <pkg> exec tsc --noEmit` (plain `--noEmit`, not `tsc -b --noEmit`, which errors on referenced projects).
