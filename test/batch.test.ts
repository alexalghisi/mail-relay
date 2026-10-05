import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "../src/db/pool.ts";
import { resetDatabase, testPool } from "./helpers/db.ts";
import { auth, createAccount, email, isolatedLimiter, testApp, testRedis, type TestAccount } from "./helpers/app.ts";

let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
let account: TestAccount;

beforeAll(async () => {
    pool = await testPool();
    redis = testRedis();
});
afterAll(async () => {
    await pool.end();
    redis.disconnect();
});
beforeEach(async () => {
    await resetDatabase(pool);
    account = await createAccount(pool);
    app = testApp(pool, isolatedLimiter(redis));
});

const countEmails = async () => (await pool.query("SELECT count(*)::int AS n FROM emails")).rows[0].n as number;
const batch = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/emails/batch", headers: auth(account, headers), payload: payload as object });
const many = (n: number) => Array.from({ length: n }, (_, i) => email({ to: [`user${i}@example.test`] }));

describe("POST /emails/batch", () => {
    it("queues up to 100 emails and returns ids in request order", async () => {
        const res = await batch(many(100));
        expect(res.statusCode).toBe(200);
        const ids = res.json().data.map((d: { id: string }) => d.id);
        expect(ids).toHaveLength(100);

        const { rows } = await pool.query("SELECT e.id, d.recipient FROM emails e JOIN deliveries d ON d.email_id = e.id");
        const recipientById = new Map(rows.map((r) => [r.id, r.recipient]));
        expect(recipientById.get(ids[42])).toBe("user42@example.test");
    });

    it("rejects more than 100 emails", async () => {
        const res = await batch(many(101));
        expect(res.statusCode).toBe(422);
        expect(await countEmails()).toBe(0);
    });

    it("rejects an empty batch", async () => {
        expect((await batch([])).statusCode).toBe(422);
    });

    it("rejects the whole batch when one email is invalid and says which", async () => {
        const emails = many(10);
        emails[7] = email({ to: ["broken"] });
        const res = await batch(emails);
        expect(res.statusCode).toBe(422);
        expect(res.json().message).toMatch(/^7\.to/);
        expect(await countEmails()).toBe(0);
    });

    it("rejects the whole batch when one sender is unverified", async () => {
        const emails = many(10);
        emails[3] = email({ from: "x@unverified.test" });
        const res = await batch(emails);
        expect(res.statusCode).toBe(403);
        expect(res.json().message).toContain("(email 3)");
        expect(await countEmails()).toBe(0);
    });

    it("honours Idempotency-Key", async () => {
        const first = await batch(many(3), { "idempotency-key": "batch-7" });
        const second = await batch(many(3), { "idempotency-key": "batch-7" });
        expect(second.json()).toEqual(first.json());
        expect(await countEmails()).toBe(3);
    });

    it("does not share keys with POST /emails", async () => {
        await app.inject({ method: "POST", url: "/emails", headers: auth(account, { "idempotency-key": "k" }), payload: email() });
        const res = await batch([email()], { "idempotency-key": "k" });
        expect(res.statusCode).toBe(409);
    });
});
