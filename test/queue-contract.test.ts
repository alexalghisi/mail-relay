import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createApiKey, createTeam, createWebhookEndpoint, setDomainConcurrency } from "../src/accounts/repository.ts";
import { insertEmail, resetDatabase, testPool } from "./helpers/db.ts";

interface Claimed {
    delivery_id: number;
    recipient: string;
    attempt: number;
    lease_token: string;
}

let pool: Pool;
let teamId: string;
let apiKeyId: string;

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

async function claim(worker: string, limit: number, lease = 60, domainLimit = 8): Promise<Claimed[]> {
    const { rows } = await pool.query<Claimed>("SELECT * FROM claim_deliveries($1, $2, $3, $4)", [worker, limit, lease, domainLimit]);
    return rows;
}

async function status(id: number): Promise<{ status: string; attempts: number; available_at: Date }> {
    const { rows } = await pool.query("SELECT status, attempts, available_at FROM deliveries WHERE id = $1", [id]);
    return rows[0];
}

async function eventTypes(emailId: string): Promise<string[]> {
    const { rows } = await pool.query<{ type: string }>("SELECT type FROM events WHERE email_id = $1 ORDER BY created_at", [emailId]);
    return rows.map((r) => r.type);
}

describe("migrations", () => {
    it("are idempotent", async () => {
        expect((await migrate(pool)).applied).toEqual([]);
    });
});

describe("claim_deliveries", () => {
    it("leases due rows once and counts the attempt", async () => {
        await insertEmail(pool, teamId, apiKeyId, ["a@x.test", "b@y.test"]);
        const first = await claim("w1", 10);
        expect(first.map((c) => c.recipient).sort()).toEqual(["a@x.test", "b@y.test"]);
        expect(first.every((c) => c.attempt === 1 && c.lease_token)).toBe(true);
        expect(await claim("w2", 10)).toEqual([]);
    });

    it("skips rows that are not due yet", async () => {
        const { deliveryIds } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        await pool.query("UPDATE deliveries SET available_at = now() + interval '1 minute' WHERE id = $1", [deliveryIds[0]]);
        expect(await claim("w1", 10)).toEqual([]);
    });

    it("hands an expired lease to another worker and fences the old one out", async () => {
        const { deliveryIds } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        const [stale] = await claim("w1", 1);
        await pool.query("UPDATE deliveries SET available_at = now() - interval '1 second' WHERE id = $1", [deliveryIds[0]]);

        const [fresh] = await claim("w2", 1);
        expect(fresh?.delivery_id).toBe(stale!.delivery_id);
        expect(fresh?.attempt).toBe(2);

        const late = await pool.query("SELECT complete_delivery($1, $2, 250, 'ok') AS ok", [stale!.delivery_id, stale!.lease_token]);
        expect(late.rows[0].ok).toBe(false);
        const current = await pool.query("SELECT complete_delivery($1, $2, 250, 'ok') AS ok", [fresh!.delivery_id, fresh!.lease_token]);
        expect(current.rows[0].ok).toBe(true);
    });

    it("kills a delivery whose lease expired on its final attempt", async () => {
        const { emailId, deliveryIds } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"], { maxAttempts: 1 });
        await claim("w1", 1);
        await pool.query("UPDATE deliveries SET available_at = now() - interval '1 second' WHERE id = $1", [deliveryIds[0]]);

        expect(await claim("w2", 1)).toEqual([]);
        expect((await status(deliveryIds[0]!)).status).toBe("dead");
        expect(await eventTypes(emailId)).toEqual(["email.bounced"]);
    });

    it("caps live leases per recipient domain across claimers", async () => {
        await setDomainConcurrency(pool, "gmail.test", 2);
        await insertEmail(pool, teamId, apiKeyId, ["1@gmail.test", "2@gmail.test", "3@gmail.test", "4@gmail.test"]);
        await insertEmail(pool, teamId, apiKeyId, ["1@other.test", "2@other.test"]);

        const first = await claim("w1", 10);
        expect(first.filter((c) => c.recipient.endsWith("@gmail.test"))).toHaveLength(2);
        expect(first.filter((c) => c.recipient.endsWith("@other.test"))).toHaveLength(2);

        expect(await claim("w2", 10)).toEqual([]);

        const done = first.find((c) => c.recipient.endsWith("@gmail.test"))!;
        await pool.query("SELECT complete_delivery($1, $2, 250, 'ok')", [done.delivery_id, done.lease_token]);
        expect(await claim("w2", 10)).toHaveLength(1);
    });
});

describe("outcomes", () => {
    it("records a delivered event and fans it out to subscribed webhooks", async () => {
        await createWebhookEndpoint(pool, teamId, "http://hooks.test/all");
        await createWebhookEndpoint(pool, teamId, "http://hooks.test/bounces", ["email.bounced"]);
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        const [c] = await claim("w1", 1);

        await pool.query("SELECT complete_delivery($1, $2, 250, '250 queued')", [c!.delivery_id, c!.lease_token]);

        expect(await eventTypes(emailId)).toEqual(["email.delivered"]);
        const { rows } = await pool.query("SELECT e.url FROM webhook_messages m JOIN webhook_endpoints e ON e.id = m.endpoint_id");
        expect(rows.map((r) => r.url)).toEqual(["http://hooks.test/all"]);
    });

    it("schedules a temporary failure with backoff and records delivery_delayed", async () => {
        const { emailId, deliveryIds } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        const [c] = await claim("w1", 1);
        const before = Date.now();

        const { rows } = await pool.query("SELECT fail_delivery($1, $2, 451, '451 try later', false, 10000, 60000) AS s", [
            c!.delivery_id,
            c!.lease_token,
        ]);

        expect(rows[0].s).toBe("queued");
        const row = await status(deliveryIds[0]!);
        const delay = row.available_at.getTime() - before;
        expect(delay).toBeGreaterThanOrEqual(5_000 - 1_000);
        expect(delay).toBeLessThanOrEqual(10_000 + 1_000);
        expect(await eventTypes(emailId)).toEqual(["email.delivery_delayed"]);
    });

    it("bounces a permanent failure without retrying", async () => {
        const { emailId, deliveryIds } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        const [c] = await claim("w1", 1);

        await pool.query("SELECT fail_delivery($1, $2, 550, '550 no such user', true, 10, 100)", [c!.delivery_id, c!.lease_token]);

        expect((await status(deliveryIds[0]!)).status).toBe("bounced");
        expect(await eventTypes(emailId)).toEqual(["email.bounced"]);
        expect(await claim("w1", 1)).toEqual([]);
    });

    it("moves a delivery to dead after max attempts", async () => {
        const { emailId, deliveryIds } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"], { maxAttempts: 3 });
        const outcomes: string[] = [];
        for (let i = 0; i < 3; i++) {
            await pool.query("UPDATE deliveries SET available_at = now() WHERE id = $1", [deliveryIds[0]]);
            const [c] = await claim("w1", 1);
            const { rows } = await pool.query("SELECT fail_delivery($1, $2, 421, 'busy', false, 10, 100) AS s", [c!.delivery_id, c!.lease_token]);
            outcomes.push(rows[0].s);
        }
        expect(outcomes).toEqual(["queued", "queued", "dead"]);
        expect(await eventTypes(emailId)).toEqual(["email.delivery_delayed", "email.delivery_delayed", "email.bounced"]);
    });
});

describe("record_event", () => {
    it("ignores a repeated dedupe key", async () => {
        const { emailId } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test"]);
        const first = await pool.query("SELECT record_event($1, NULL, 'email.sent', '{}', 'k1') AS id", [emailId]);
        const second = await pool.query("SELECT record_event($1, NULL, 'email.sent', '{}', 'k1') AS id", [emailId]);
        expect(first.rows[0].id).toBeTruthy();
        expect(second.rows[0].id).toBeNull();
        expect(await eventTypes(emailId)).toEqual(["email.sent"]);
    });
});

describe("retry_delay", () => {
    it("doubles per attempt within the jitter band and respects the cap", async () => {
        const { rows } = await pool.query<{ attempt: number; ms: number }>(`
            SELECT a AS attempt, (extract(epoch FROM retry_delay(a, 1000, 20000)) * 1000)::float8 AS ms
            FROM generate_series(1, 8) a, generate_series(1, 50)`);
        for (const { attempt, ms } of rows) {
            const full = Math.min(20_000, 1000 * 2 ** (attempt - 1));
            expect(ms).toBeGreaterThanOrEqual(full / 2);
            expect(ms).toBeLessThanOrEqual(full);
        }
    });
});
