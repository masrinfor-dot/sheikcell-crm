---
name: Schema change path
description: How to ship DB schema changes — drizzle push is broken by drift
---
`pnpm run push` in `lib/db` aborts on pre-existing drift (dev DB `bot_usage` lacks `tenant_id`), so drizzle-kit cannot apply anything until fixed. **The sanctioned path:** add an idempotent SQL file to `migrations/` and register it in `MIGRATION_FILES` (api-server boot migration runner) — this is the only mechanism that also creates the schema on deployed/fresh databases. **Why:** a dev-only manual `psql` change works locally but leaves prod without the table. **How to apply:** every new table/column ships as a numbered idempotent migration + matching drizzle schema file.
