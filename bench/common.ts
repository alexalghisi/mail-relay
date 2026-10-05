import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createApiKey, createTeam, addDomain } from "../src/accounts/repository.ts";
import { migrate } from "../src/db/migrate.ts";
import { createPool, type Pool } from "../src/db/pool.ts";

export const BENCH_DATABASE_URL = process.env.MAILRELAY_BENCH_DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/mailrelay_bench";

const ROOT = new URL("..", import.meta.url).pathname;

/** Drops and recreates the bench schema, then seeds one team with a verified domain. */
export async function freshDatabase(): Promise<{ pool: Pool; teamId: string; apiKeyId: string; token: string }> {
    const pool = createPool(BENCH_DATABASE_URL, 10);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    const teamId = await createTeam(pool, "bench");
    const key = await createApiKey(pool, teamId, { rateBurst: 1_000_000, ratePerSec: 1_000_000 });
    await addDomain(pool, teamId, "acme.test", true);
    return { pool, teamId, apiKeyId: key.id, token: key.token };
}

/**
 * Queues `count` single-recipient emails in bulk with SQL, so the benchmark
 * measures the queue and workers rather than the API. `recipient(i)` is
 * evaluated in SQL; use `i` for the row number.
 */
export async function enqueue(pool: Pool, teamId: string, apiKeyId: string, count: number, recipientSql: string): Promise<void> {
    await pool.query(
        `WITH e AS (
            INSERT INTO emails (team_id, api_key_id, from_header, from_email, recipients, subject, text_body)
            SELECT $1, $2, 'Acme <hello@acme.test>', 'hello@acme.test', ARRAY[${recipientSql}], 'Bench ' || i, 'Hello from the benchmark.'
            FROM generate_series(1, $3) i
            RETURNING id, recipients[1] AS r
         )
         INSERT INTO deliveries (email_id, recipient, recipient_domain)
         SELECT id, r, split_part(r, '@', 2) FROM e`,
        [teamId, apiKeyId, count],
    );
}

export async function countByStatus(pool: Pool, where = "true"): Promise<Record<string, number>> {
    const { rows } = await pool.query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM deliveries WHERE ${where} GROUP BY status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export async function waitUntil(check: () => Promise<boolean>, timeoutMs = 600_000): Promise<number> {
    const started = performance.now();
    while (!(await check())) {
        if (performance.now() - started > timeoutMs) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 50));
    }
    return performance.now() - started;
}

export type WorkerKind = "ts" | "go";

/** Starts a worker as a separate process, the way it runs in production. */
export function startWorker(kind: WorkerKind, env: Record<string, string>): ChildProcess {
    const fullEnv = { ...process.env, DATABASE_URL: BENCH_DATABASE_URL, ...env };
    const stdio: ["ignore", "ignore", "inherit"] = ["ignore", "ignore", "inherit"];
    return kind === "ts"
        ? spawn(process.execPath, ["src/cli.ts", "worker"], { cwd: ROOT, env: fullEnv, stdio })
        : spawn(`${ROOT}go/bin/relay-worker`, [], { cwd: ROOT, env: fullEnv, stdio });
}

export function startProcess(args: string[], env: Record<string, string>, stdout: "pipe" | "ignore" = "ignore"): ChildProcess {
    return spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", stdout, "inherit"] });
}

export async function stopAll(children: ChildProcess[]): Promise<void> {
    await Promise.all(
        children.map(async (child) => {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            await once(child, "exit");
        }),
    );
}

export function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
