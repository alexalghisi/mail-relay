/**
 * The dequeue query with and without its partial index, on a table that holds
 * a million finished deliveries and a thousand due ones.
 *
 *   node bench/explain.ts
 */
import type { Pool } from "../src/db/pool.ts";
import { freshDatabase } from "./common.ts";

const DEQUEUE = `
    SELECT d.* FROM deliveries d
    WHERE d.status IN ('queued', 'sending') AND d.available_at <= now() AND d.recipient_domain <> ALL ('{}')
    ORDER BY d.available_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED`;

const { pool, teamId, apiKeyId } = await freshDatabase();

console.log("loading 1,000,000 delivered rows and 1,000 due rows...");
await pool.query(
    `INSERT INTO emails (team_id, api_key_id, from_header, from_email, recipients, subject, text_body, created_at)
     SELECT $1, $2, 'hello@acme.test', 'hello@acme.test', '{}', 'History', 'x', now() - (i || ' seconds')::interval
     FROM generate_series(1, 100000) i`,
    [teamId, apiKeyId],
);
await pool.query(`
    INSERT INTO deliveries (email_id, recipient, recipient_domain, status, attempts, available_at, created_at, updated_at)
    SELECT e.id, 'u' || n || '@d' || (n % 50) || '.test', 'd' || (n % 50) || '.test', 'delivered', 1,
           e.created_at, e.created_at, e.created_at
    FROM emails e, generate_series(1, 10) n`);
await pool.query(`
    INSERT INTO deliveries (email_id, recipient, recipient_domain, status, available_at)
    SELECT e.id, 'due' || n || '@d' || (n % 50) || '.test', 'd' || (n % 50) || '.test', 'queued', now() - interval '1 minute'
    FROM (SELECT id FROM emails LIMIT 100) e, generate_series(1, 10) n`);
await pool.query("VACUUM ANALYZE deliveries");

async function explain(db: Pool, sql: string): Promise<string[]> {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${sql}`);
        await client.query("ROLLBACK");
        return rows.map((r) => r["QUERY PLAN"]);
    } finally {
        client.release();
    }
}

async function claimTiming(db: Pool): Promise<number> {
    const client = await db.connect();
    try {
        const samples: number[] = [];
        for (let i = 0; i < 20; i++) {
            await client.query("BEGIN");
            const t = performance.now();
            await client.query("SELECT * FROM claim_deliveries('bench', 32, 60, 8)");
            samples.push(performance.now() - t);
            await client.query("ROLLBACK");
        }
        samples.sort((a, b) => a - b);
        return samples[10]!;
    } finally {
        client.release();
    }
}

async function size(name: string): Promise<string> {
    const { rows } = await pool.query<{ s: string }>("SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS s", [name]);
    return rows[0]!.s;
}

await pool.query("DROP INDEX deliveries_dequeue_idx");
console.log("\n--- without deliveries_dequeue_idx ---");
console.log((await explain(pool, DEQUEUE)).join("\n"));
console.log(`claim_deliveries(limit 32), median of 20: ${(await claimTiming(pool)).toFixed(1)} ms`);

await pool.query("CREATE INDEX CONCURRENTLY deliveries_dequeue_idx ON deliveries (available_at) WHERE status IN ('queued', 'sending')");
await pool.query("ANALYZE deliveries");
console.log("\n--- with deliveries_dequeue_idx (partial) ---");
console.log((await explain(pool, DEQUEUE)).join("\n"));
console.log(`claim_deliveries(limit 32), median of 20: ${(await claimTiming(pool)).toFixed(1)} ms`);

await pool.query("CREATE INDEX deliveries_status_available_at_full_idx ON deliveries (status, available_at)");
console.log(`\nindex size: partial ${await size("deliveries_dequeue_idx")}, full (status, available_at) ${await size("deliveries_status_available_at_full_idx")}`);
await pool.end();
