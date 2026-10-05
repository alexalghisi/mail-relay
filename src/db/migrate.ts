import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "./pool.ts";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url).pathname;
const NO_TRANSACTION = /^--\s*migrate:\s*no-transaction/;
const LOCK_KEY = 72_011_001;

export interface MigrationResult {
    applied: string[];
}

/**
 * Applies pending migrations in file name order. A session advisory lock keeps
 * two deploys from migrating at once. Files starting with
 * `-- migrate: no-transaction` run statement by statement outside a
 * transaction, which CREATE INDEX CONCURRENTLY requires.
 */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
    const client = await pool.connect();
    try {
        await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )`);
        const done = new Set(
            (await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
        );
        const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
        const applied: string[] = [];

        for (const file of files) {
            if (done.has(file)) continue;
            const sql = await readFile(join(dir, file), "utf8");
            if (NO_TRANSACTION.test(sql)) {
                for (const statement of splitStatements(sql)) await client.query(statement);
                await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
            } else {
                await client.query("BEGIN");
                try {
                    await client.query(sql);
                    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
                    await client.query("COMMIT");
                } catch (error) {
                    await client.query("ROLLBACK");
                    throw error;
                }
            }
            applied.push(file);
        }
        return { applied };
    } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
        client.release();
    }
}

// Good enough for the no-transaction files, which hold plain DDL without
// function bodies or string literals containing semicolons.
function splitStatements(sql: string): string[] {
    return sql
        .split(/;\s*$/m)
        .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
        .filter((s) => s.length > 0);
}
