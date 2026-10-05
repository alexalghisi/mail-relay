import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey, createTeam, createWebhookEndpoint } from "../src/accounts/repository.ts";
import type { Pool } from "../src/db/pool.ts";
import { FakeMta } from "../src/mta/fake-mta.ts";
import { DeliveryQueue } from "../src/queue/deliveries.ts";
import { DeliveryWorker } from "../src/queue/worker.ts";
import { SmtpSender } from "../src/smtp/sender.ts";
import { WebhookDispatcher } from "../src/webhooks/dispatcher.ts";
import { verify } from "../src/webhooks/signing.ts";
import { insertEmail, resetDatabase, testPool } from "./helpers/db.ts";
import { WebhookReceiver } from "./helpers/receiver.ts";
import { waitFor } from "./helpers/wait.ts";

let pool: Pool;
let teamId: string;
let apiKeyId: string;
const cleanups: (() => Promise<void>)[] = [];

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
});
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
});

async function receiver(statuses: number[] = []): Promise<{ receiver: WebhookReceiver; url: string }> {
    const r = new WebhookReceiver(statuses);
    const url = await r.listen();
    cleanups.push(() => r.close());
    return { receiver: r, url };
}

function dispatcher(options: { maxAttempts?: number; db?: Pool } = {}): WebhookDispatcher {
    const d = new WebhookDispatcher({ db: options.db ?? pool, retryBaseMs: 20, retryCapMs: 50, idleMs: 20, timeoutMs: 2_000, ...options });
    d.start();
    cleanups.push(() => d.stop());
    return d;
}

async function recordSent(emailId: string): Promise<void> {
    await pool.query("SELECT record_event($1::uuid, NULL, 'email.sent', '{\"subject\":\"Hi\"}', 'sent:' || $1::text)", [emailId]);
}

async function messageStatus(): Promise<{ status: string; attempts: number }[]> {
    const { rows } = await pool.query("SELECT status, attempts FROM webhook_messages ORDER BY created_at");
    return rows;
}

describe("WebhookDispatcher", () => {
    it("posts a signed event that verify() accepts", async () => {
        const { receiver: r, url } = await receiver();
        const { secret } = await createWebhookEndpoint(pool, teamId, url);
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        await recordSent(emailId);
        dispatcher();

        await waitFor(() => r.requests.length === 1);
        const [request] = r.requests;
        expect(request!.headers["webhook-id"]).toMatch(/^msg_[0-9a-f]{32}$/);
        expect(verify(secret, request!.headers, request!.body)).toMatchObject({
            type: "email.sent",
            data: { email_id: emailId, subject: "Hi" },
        });
        await waitFor(async () => (await messageStatus())[0]?.status === "delivered");
    });

    it("retries failed attempts with the same webhook-id until one succeeds", async () => {
        const { receiver: r, url } = await receiver([500, 503]);
        const { secret } = await createWebhookEndpoint(pool, teamId, url);
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        await recordSent(emailId);
        dispatcher();

        await waitFor(async () => (await messageStatus())[0]?.status === "delivered");
        expect(r.requests.map((q) => q.status)).toEqual([500, 503, 200]);
        expect(new Set(r.requests.map((q) => q.headers["webhook-id"])).size).toBe(1);
        for (const q of r.requests) expect(() => verify(secret, q.headers, q.body)).not.toThrow();
        expect(await messageStatus()).toEqual([{ status: "delivered", attempts: 3 }]);
    });

    it("gives up after max attempts", async () => {
        const { receiver: r, url } = await receiver([500, 500, 500, 500]);
        await createWebhookEndpoint(pool, teamId, url);
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        await recordSent(emailId);
        dispatcher({ maxAttempts: 3 });

        await waitFor(async () => (await messageStatus())[0]?.status === "failed");
        expect(r.requests).toHaveLength(3);
        const { rows } = await pool.query("SELECT last_status_code, last_error FROM webhook_messages");
        expect(rows[0]).toEqual({ last_status_code: 500, last_error: "HTTP 500" });
    });

    it("treats an unreachable endpoint as a failed attempt", async () => {
        await createWebhookEndpoint(pool, teamId, "http://127.0.0.1:1/hooks");
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        await recordSent(emailId);
        dispatcher({ maxAttempts: 1 });

        await waitFor(async () => (await messageStatus())[0]?.status === "failed");
        const { rows } = await pool.query("SELECT last_status_code, last_error FROM webhook_messages");
        expect(rows[0].last_status_code).toBeNull();
        expect(rows[0].last_error).toMatch(/fetch failed|ECONNREFUSED/);
    });

    it("sends each message once with several dispatchers running", async () => {
        const { receiver: r, url } = await receiver();
        await createWebhookEndpoint(pool, teamId, url);
        for (let i = 0; i < 40; i++) {
            const { emailId } = await insertEmail(pool, teamId, apiKeyId, [`u${i}@x.test`]);
            await recordSent(emailId);
        }
        const pools: Pool[] = [];
        for (let i = 0; i < 4; i++) {
            const p = await testPool(3);
            pools.push(p);
            dispatcher({ db: p });
        }
        cleanups.unshift(async () => {
            await Promise.all(pools.map((p) => p.end()));
        });

        await waitFor(async () => (await messageStatus()).every((m) => m.status === "delivered"));
        expect(r.requests).toHaveLength(40);
        expect(new Set(r.requests.map((q) => q.headers["webhook-id"])).size).toBe(40);
    });

    it("ignores a settle from an attempt whose lease was taken over", async () => {
        const { url } = await receiver();
        await createWebhookEndpoint(pool, teamId, url);
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        await recordSent(emailId);
        const d = new WebhookDispatcher({ db: pool, leaseSeconds: 1 });

        const [stale] = await d.claim(1);
        await pool.query("UPDATE webhook_messages SET available_at = now()");
        const [fresh] = await d.claim(1);
        expect(fresh!.attempt).toBe(2);

        await d.deliver({ ...stale!, url: "http://127.0.0.1:1/hooks" });
        expect(await messageStatus()).toEqual([{ status: "pending", attempts: 2 }]);
        await d.deliver(fresh!);
        expect(await messageStatus()).toEqual([{ status: "delivered", attempts: 2 }]);
    });
});

describe("delivery to webhook, end to end", () => {
    it("reports delivered, delayed and bounced outcomes as signed webhooks", async () => {
        const { receiver: r, url } = await receiver();
        const { secret } = await createWebhookEndpoint(pool, teamId, url, ["email.delivered", "email.delivery_delayed", "email.bounced"]);
        const mta = new FakeMta();
        const port = await mta.listen();
        const sender = new SmtpSender({ host: "127.0.0.1", port });
        const worker = new DeliveryWorker({
            queue: new DeliveryQueue(pool, { leaseSeconds: 30, defaultDomainConcurrency: 4, retryBaseMs: 20, retryCapMs: 50 }),
            sender,
            concurrency: 4,
            idleMs: 20,
        });
        worker.start();
        cleanups.push(async () => {
            await worker.stop();
            sender.close();
            await mta.close();
        });
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["ok@x.test", "flaky@x.test", "bounce@x.test"]);
        await recordSent(emailId);
        dispatcher();

        await waitFor(() => r.requests.length === 4);
        const events = r.requests.map((q) => verify(secret, q.headers, q.body) as { type: string; data: { to: string } });
        expect(events.map((e) => `${e.type} ${e.data.to}`).sort()).toEqual([
            "email.bounced bounce@x.test",
            "email.delivered flaky@x.test",
            "email.delivered ok@x.test",
            "email.delivery_delayed flaky@x.test",
        ]);
    });
});
