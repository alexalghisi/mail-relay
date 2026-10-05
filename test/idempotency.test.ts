import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { canonicalJson, deleteExpiredKeys } from "../src/api/idempotency.ts";
import type { Pool } from "../src/db/pool.ts";
import { resetDatabase, testPool } from "./helpers/db.ts";
import { auth, createAccount, email, isolatedLimiter, testApp, testRedis, type TestAccount } from "./helpers/app.ts";

let pool: Pool;
let redis: Redis;
let app: FastifyInstance;
let account: TestAccount;

beforeAll(async () => {
    pool = await testPool(20);
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

function post(payload: unknown, key: string) {
    return app.inject({ method: "POST", url: "/emails", headers: auth(account, { "idempotency-key": key }), payload: payload as object });
}

describe("Idempotency-Key", () => {
    it("replays the original response for the same key and body", async () => {
        const first = await post(email(), "order-1001");
        const second = await post(email(), "order-1001");

        expect(second.statusCode).toBe(200);
        expect(second.json()).toEqual(first.json());
        expect(second.headers["idempotent-replayed"]).toBe("true");
        expect(first.headers["idempotent-replayed"]).toBeUndefined();
        expect(await countEmails()).toBe(1);
    });

    it("treats a body with reordered keys as the same request", async () => {
        const first = await post({ subject: "Hi", text: "x", to: ["a@example.test"], from: "hello@acme.test" }, "k");
        const second = await post({ from: "hello@acme.test", to: ["a@example.test"], text: "x", subject: "Hi" }, "k");
        expect(second.json()).toEqual(first.json());
    });

    it("rejects the same key with a different body", async () => {
        await post(email(), "order-1001");
        const res = await post(email({ subject: "Something else" }), "order-1001");
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ name: "invalid_idempotent_request" });
        expect(await countEmails()).toBe(1);
    });

    it("creates exactly one email when the same key arrives concurrently", async () => {
        const responses = await Promise.all(Array.from({ length: 25 }, () => post(email(), "burst")));

        expect(responses.every((r) => r.statusCode === 200)).toBe(true);
        expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
        expect(responses.filter((r) => r.headers["idempotent-replayed"] !== "true")).toHaveLength(1);
        expect(await countEmails()).toBe(1);
    });

    it("scopes keys per team", async () => {
        const other = await createAccount(pool);
        const mine = await post(email(), "shared");
        const theirs = await app.inject({ method: "POST", url: "/emails", headers: auth(other, { "idempotency-key": "shared" }), payload: email() });
        expect(theirs.json().id).not.toBe(mine.json().id);
    });

    it("does not burn the key when the request fails", async () => {
        const failed = await post(email({ from: "x@unverified.test" }), "retry-me");
        expect(failed.statusCode).toBe(403);
        const retried = await post(email({ from: "x@unverified.test", subject: "fixed" }), "retry-me");
        expect(retried.statusCode).toBe(403);
        expect((await pool.query("SELECT count(*)::int AS n FROM idempotency_keys")).rows[0].n).toBe(0);
    });

    it("lets an expired key be used for a new request", async () => {
        const first = await post(email(), "old");
        await pool.query("UPDATE idempotency_keys SET expires_at = now() - interval '1 second'");
        const second = await post(email({ subject: "New one" }), "old");

        expect(second.statusCode).toBe(200);
        expect(second.json().id).not.toBe(first.json().id);
        expect(await countEmails()).toBe(2);
    });

    it("expires keys after the configured TTL and cleans them up", async () => {
        app = testApp(pool, isolatedLimiter(redis), 60);
        await post(email(), "short");
        const { rows } = await pool.query("SELECT extract(epoch FROM expires_at - created_at)::int AS ttl FROM idempotency_keys");
        expect(rows[0].ttl).toBe(60);

        await pool.query("UPDATE idempotency_keys SET expires_at = now() - interval '1 second'");
        expect(await deleteExpiredKeys(pool)).toBe(1);
    });

    it("rejects keys longer than 256 characters", async () => {
        const res = await post(email(), "k".repeat(257));
        expect(res.statusCode).toBe(422);
    });
});

describe("canonicalJson", () => {
    it("sorts keys at every level and keeps array order", () => {
        expect(canonicalJson({ b: [{ y: 1, x: 2 }], a: null, c: undefined })).toBe('{"a":null,"b":[{"x":2,"y":1}]}');
    });
});
