/**
 * POST /emails latency over HTTP with real Postgres and Redis. The API runs
 * as its own process; latency is measured from the client.
 *
 *   node bench/api-latency.ts [requests] [concurrency...]
 */
import { once } from "node:events";
import { BENCH_DATABASE_URL, freshDatabase, percentile, startProcess, stopAll } from "./common.ts";

const total = Number(process.argv[2] ?? 5_000);
const levels = process.argv.slice(3).map(Number);
const PORT = 3999;

const seeded = await freshDatabase();
const api = startProcess(["src/cli.ts", "api"], { PORT: String(PORT), DATABASE_URL: BENCH_DATABASE_URL }, "pipe");
await once(api.stdout!, "data");
const url = `http://127.0.0.1:${PORT}/emails`;

async function run(label: string, withKey: boolean, concurrency: number) {
    const latencies: number[] = [];
    let next = 0;
    let errors = 0;
    const started = performance.now();
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (next < total) {
                const i = next++;
                const headers: Record<string, string> = { authorization: `Bearer ${seeded.token}`, "content-type": "application/json" };
                if (withKey) headers["idempotency-key"] = `${label}-${concurrency}-${i}`;
                const t = performance.now();
                const res = await fetch(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        from: "Acme <hello@acme.test>",
                        to: [`user${i}@example.test`, `user${i}@other.test`],
                        subject: `Order ${i} confirmed`,
                        html: `<p>Thanks for order ${i}.</p>`,
                        tags: [{ name: "category", value: "receipt" }],
                    }),
                });
                await res.arrayBuffer();
                latencies.push(performance.now() - t);
                if (res.status !== 200) errors++;
            }
        }),
    );
    const seconds = (performance.now() - started) / 1000;
    latencies.sort((a, b) => a - b);
    console.log(
        JSON.stringify({
            run: label,
            requests: total,
            concurrency,
            errors,
            requests_per_second: Math.round(total / seconds),
            p50_ms: +percentile(latencies, 50).toFixed(1),
            p95_ms: +percentile(latencies, 95).toFixed(1),
            p99_ms: +percentile(latencies, 99).toFixed(1),
        }),
    );
}

await run("warmup", false, 16);
for (const concurrency of levels.length ? levels : [8, 32]) {
    await run("without Idempotency-Key", false, concurrency);
    await run("with Idempotency-Key", true, concurrency);
}

await stopAll([api]);
await seeded.pool.end();
