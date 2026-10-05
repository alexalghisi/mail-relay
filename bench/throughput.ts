/**
 * Queue throughput: emails per second from the queue to the fake MTA, with
 * workers running as separate processes.
 *
 *   node bench/throughput.ts [count] [ts|go|mixed] [processes] [concurrency]
 */
import { FakeMta } from "../src/mta/fake-mta.ts";
import { countByStatus, enqueue, freshDatabase, startWorker, stopAll, waitUntil, type WorkerKind } from "./common.ts";

const count = Number(process.argv[2] ?? 20_000);
const mode = (process.argv[3] ?? "ts") as WorkerKind | "mixed";
const processes = Number(process.argv[4] ?? 2);
const concurrency = Number(process.argv[5] ?? 32);

const { pool, teamId, apiKeyId } = await freshDatabase();
await enqueue(pool, teamId, apiKeyId, count, "'user' || i || '@d' || (i % 20) || '.test'");

const mta = new FakeMta();
const port = await mta.listen();
const kinds: WorkerKind[] = Array.from({ length: processes }, (_, i) => (mode === "mixed" ? (i % 2 ? "go" : "ts") : mode));
const workers = kinds.map((kind) =>
    startWorker(kind, { SMTP_PORT: String(port), WORKER_CONCURRENCY: String(concurrency), DOMAIN_CONCURRENCY: "64" }),
);

const ms = await waitUntil(async () => ((await countByStatus(pool)).delivered ?? 0) === count);
await stopAll(workers);

const ids = new Set(mta.received.map((m) => m.deliveryId));
console.log(
    JSON.stringify({
        workers: kinds.join("+"),
        concurrency,
        emails: count,
        seconds: +(ms / 1000).toFixed(2),
        emails_per_second: Math.round(count / (ms / 1000)),
        received_by_mta: mta.received.length,
        duplicates: mta.received.length - ids.size,
    }),
);
await mta.close();
await pool.end();
