/**
 * Head-of-line blocking: 2,000 emails to ten healthy domains queued behind
 * 1,000 emails to one domain whose MTA takes a second per message. Measures how
 * long the healthy domains take with and without the per-domain cap.
 *
 *   node bench/slow-domain.ts
 */
import { setDomainConcurrency } from "../src/accounts/repository.ts";
import { FakeMta } from "../src/mta/fake-mta.ts";
import { countByStatus, enqueue, freshDatabase, startWorker, stopAll, waitUntil } from "./common.ts";

const SLOW_MS = 1_000;

async function scenario(name: string, slowDomainLimit: number | undefined, withSlowDomain = true) {
    const { pool, teamId, apiKeyId } = await freshDatabase();
    // The slow domain's mail is queued first, so it is at the head of the queue.
    if (withSlowDomain) await enqueue(pool, teamId, apiKeyId, 1_000, "'user' || i || '@slow.test'");
    await enqueue(pool, teamId, apiKeyId, 2_000, "'user' || i || '@d' || (i % 10) || '.test'");
    if (slowDomainLimit) await setDomainConcurrency(pool, "slow.test", slowDomainLimit);

    const mta = new FakeMta({ slowDomains: { "slow.test": SLOW_MS } });
    const port = await mta.listen();
    const workers = [0, 1].map(() =>
        startWorker("ts", { SMTP_PORT: String(port), WORKER_CONCURRENCY: "32", DOMAIN_CONCURRENCY: slowDomainLimit ? "16" : "1000" }),
    );

    const healthy = "recipient_domain <> 'slow.test'";
    const ms = await waitUntil(async () => ((await countByStatus(pool, healthy)).delivered ?? 0) === 2_000);
    const slowDelivered = (await countByStatus(pool, "recipient_domain = 'slow.test'")).delivered ?? 0;
    await stopAll(workers);
    await mta.close();
    await pool.end();

    console.log(
        JSON.stringify({
            scenario: name,
            healthy_domains_done_seconds: +(ms / 1000).toFixed(2),
            slow_domain_delivered_meanwhile: withSlowDomain ? slowDelivered : null,
            slow_domain_peak_concurrency: mta.peakConcurrency.get("slow.test") ?? 0,
        }),
    );
}

await scenario("no slow domain (baseline)", 5, false);
await scenario("slow domain, capped at 5 connections", 5);
await scenario("slow domain, no cap", undefined);
