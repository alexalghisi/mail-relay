import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey, createTeam, setDomainConcurrency } from "../src/accounts/repository.ts";
import type { Pool } from "../src/db/pool.ts";
import { FakeMta } from "../src/mta/fake-mta.ts";
import { DeliveryQueue, type QueueOptions } from "../src/queue/deliveries.ts";
import { DeliveryWorker } from "../src/queue/worker.ts";
import { SmtpSender } from "../src/smtp/sender.ts";
import { insertEmail, resetDatabase, testPool } from "./helpers/db.ts";
import { waitFor } from "./helpers/wait.ts";

let pool: Pool;
let mta: FakeMta;
let port: number;
let teamId: string;
let apiKeyId: string;
const cleanups: (() => Promise<void>)[] = [];

const fastRetries: QueueOptions = { leaseSeconds: 30, defaultDomainConcurrency: 8, retryBaseMs: 20, retryCapMs: 100 };

beforeAll(async () => {
    pool = await testPool();
});
afterAll(async () => {
    await pool.end();
});
beforeEach(async () => {
    await resetDatabase(pool);
    teamId = await createTeam(pool, "acme");
    apiKeyId = (await createApiKey(pool, teamId)).id;
    mta = new FakeMta({ slowDomains: { "slow.test": 300 } });
    port = await mta.listen();
});
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    await mta.close();
});

function startWorker(options: Partial<QueueOptions> & { concurrency?: number; smtpPort?: number; db?: Pool } = {}): DeliveryWorker {
    const sender = new SmtpSender({ host: "127.0.0.1", port: options.smtpPort ?? port, timeoutMs: 5_000 });
    const worker = new DeliveryWorker({
        queue: new DeliveryQueue(options.db ?? pool, { ...fastRetries, ...options }),
        sender,
        concurrency: options.concurrency ?? 8,
        idleMs: 20,
    });
    worker.start();
    cleanups.push(async () => {
        await worker.stop();
        sender.close();
    });
    return worker;
}

async function statuses(): Promise<Record<string, string>> {
    const { rows } = await pool.query<{ recipient: string; status: string }>("SELECT recipient, status FROM deliveries");
    return Object.fromEntries(rows.map((r) => [r.recipient, r.status]));
}

async function settled(): Promise<boolean> {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM deliveries WHERE status IN ('queued', 'sending')");
    return rows[0].n === 0;
}

async function eventTypes(emailId: string): Promise<string[]> {
    const { rows } = await pool.query<{ type: string }>("SELECT type FROM events WHERE email_id = $1 ORDER BY created_at", [emailId]);
    return rows.map((r) => r.type);
}

describe("DeliveryWorker", () => {
    it("delivers over SMTP with stable message headers", async () => {
        const { emailId, deliveryIds } = await insertEmail(pool, teamId, apiKeyId, ["ana@example.test"]);
        startWorker();
        await waitFor(settled);

        expect(await statuses()).toEqual({ "ana@example.test": "delivered" });
        expect(mta.received).toHaveLength(1);
        expect(mta.received[0]).toMatchObject({
            from: "hello@acme.test",
            to: ["ana@example.test"],
            deliveryId: String(deliveryIds[0]),
            messageId: `<${emailId}.${deliveryIds[0]}@mail-relay>`,
        });
        expect(await eventTypes(emailId)).toEqual(["email.delivered"]);
    });

    it("retries a 4xx and delivers on the next attempt", async () => {
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["flaky@example.test"]);
        startWorker();
        await waitFor(settled);

        expect(await statuses()).toEqual({ "flaky@example.test": "delivered" });
        expect(mta.rejected).toEqual([{ to: "flaky@example.test", code: 451 }]);
        expect(await eventTypes(emailId)).toEqual(["email.delivery_delayed", "email.delivered"]);
        const { rows } = await pool.query("SELECT attempts FROM deliveries");
        expect(rows[0].attempts).toBe(2);
    });

    it("bounces a 5xx without retrying", async () => {
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["bounce@example.test", "ok@example.test"]);
        startWorker();
        await waitFor(settled);

        expect(await statuses()).toEqual({ "bounce@example.test": "bounced", "ok@example.test": "delivered" });
        expect(mta.rejected).toEqual([{ to: "bounce@example.test", code: 550 }]);
        const bounced = await pool.query("SELECT payload FROM events WHERE type = 'email.bounced' AND email_id = $1", [emailId]);
        expect(bounced.rows[0].payload).toMatchObject({ bounce_type: "permanent", smtp_code: 550 });
    });

    it("gives up on a 4xx after max attempts", async () => {
        await insertEmail(pool, teamId, apiKeyId, ["tempfail@example.test"], { maxAttempts: 3 });
        startWorker();
        await waitFor(settled);

        expect(await statuses()).toEqual({ "tempfail@example.test": "dead" });
        expect(mta.rejected).toHaveLength(3);
    });

    it("retries when the MTA can't be reached", async () => {
        await insertEmail(pool, teamId, apiKeyId, ["ana@example.test"]);
        startWorker({ smtpPort: 1, retryBaseMs: 60_000, retryCapMs: 60_000 });
        await waitFor(async () => (await statuses())["ana@example.test"] === "queued" && (await pool.query("SELECT attempts FROM deliveries")).rows[0].attempts === 1);

        const { rows } = await pool.query("SELECT last_smtp_code, last_smtp_response, available_at > now() + interval '20 seconds' AS later FROM deliveries");
        expect(rows[0]).toMatchObject({ last_smtp_code: null, later: true });
        expect(rows[0].last_smtp_response).toMatch(/ECONNREFUSED/);
    });

    it("never delivers a message twice with many workers on the same queue", async () => {
        const recipients = Array.from({ length: 300 }, (_, i) => `user${i}@d${i % 7}.test`);
        for (let i = 0; i < recipients.length; i += 50) await insertEmail(pool, teamId, apiKeyId, recipients.slice(i, i + 50));

        const pools: Pool[] = [];
        for (let i = 0; i < 8; i++) {
            const workerPool = await testPool(4);
            pools.push(workerPool);
            startWorker({ db: workerPool, concurrency: 6 });
        }
        cleanups.unshift(async () => {
            await Promise.all(pools.map((p) => p.end()));
        });
        await waitFor(settled, 20_000);

        expect(mta.received).toHaveLength(300);
        expect(new Set(mta.received.map((m) => m.deliveryId)).size).toBe(300);
        const { rows } = await pool.query("SELECT count(*)::int AS n FROM events WHERE type = 'email.delivered'");
        expect(rows[0].n).toBe(300);
    });

    it("recovers deliveries whose worker died mid-send", async () => {
        const { deliveryIds } = await insertEmail(pool, teamId, apiKeyId, ["a@example.test", "b@example.test"]);
        // A worker that claims with a 1 second lease and then disappears.
        await pool.query("SELECT * FROM claim_deliveries('crashed-worker', 10, 1, 8)");
        startWorker();

        await new Promise((r) => setTimeout(r, 300));
        expect(mta.received).toHaveLength(0);

        await waitFor(settled, 5_000);
        expect(mta.received.map((m) => Number(m.deliveryId)).sort()).toEqual(deliveryIds);
        const { rows } = await pool.query("SELECT DISTINCT attempts FROM deliveries");
        expect(rows).toEqual([{ attempts: 2 }]);
    });

    it("keeps a slow domain from holding up the others", async () => {
        await setDomainConcurrency(pool, "slow.test", 2);
        await insertEmail(pool, teamId, apiKeyId, Array.from({ length: 10 }, (_, i) => `u${i}@slow.test`));
        await insertEmail(pool, teamId, apiKeyId, Array.from({ length: 40 }, (_, i) => `u${i}@fast.test`));
        const started = Date.now();
        startWorker({ concurrency: 8 });

        await waitFor(async () => {
            const { rows } = await pool.query("SELECT count(*)::int AS n FROM deliveries WHERE recipient_domain = 'fast.test' AND status = 'delivered'");
            return rows[0].n === 40;
        });
        const fastDone = Date.now() - started;
        await waitFor(settled);
        const slowDone = Date.now() - started;

        // 10 messages at 300 ms each, two at a time, can't finish in under 1.5 s.
        expect(slowDone).toBeGreaterThanOrEqual(1_500);
        expect(fastDone).toBeLessThan(750);
        expect(mta.peakConcurrency.get("slow.test")).toBe(2);
    });

    it("finishes in-flight sends before stopping", async () => {
        await insertEmail(pool, teamId, apiKeyId, ["a@slow.test", "b@slow.test", "c@slow.test"]);
        const worker = startWorker({ concurrency: 3 });
        await waitFor(async () => (await pool.query("SELECT count(*)::int AS n FROM deliveries WHERE status = 'sending'")).rows[0].n === 3);

        await worker.stop();

        expect(await statuses()).toEqual({ "a@slow.test": "delivered", "b@slow.test": "delivered", "c@slow.test": "delivered" });
        expect(mta.received).toHaveLength(3);
    });

    it("does not claim new work once stopping", async () => {
        const worker = startWorker();
        await worker.stop();
        await insertEmail(pool, teamId, apiKeyId, ["late@example.test"]);
        await new Promise((r) => setTimeout(r, 100));
        expect(await statuses()).toEqual({ "late@example.test": "queued" });
    });
});
