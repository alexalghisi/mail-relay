import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { FailOpenRateLimiter, type RateLimiter } from "../src/api/rate-limit.ts";
import type { Pool } from "../src/db/pool.ts";
import { resetDatabase, testPool } from "./helpers/db.ts";
import { auth, createAccount, email, isolatedLimiter, testApp, testRedis } from "./helpers/app.ts";

let pool: Pool;
let redis: Redis;
let limiter: RateLimiter;

beforeAll(async () => {
    pool = await testPool();
    redis = testRedis();
});
afterAll(async () => {
    await pool.end();
    redis.disconnect();
});
beforeEach(() => {
    limiter = isolatedLimiter(redis);
});

describe("RedisTokenBucket", () => {
    it("allows a burst, then refuses with a retry hint", async () => {
        const decisions = [];
        for (let i = 0; i < 6; i++) decisions.push(await limiter.take("key", 5, 2));
        expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, true, true, false]);
        expect(decisions[4]!.remaining).toBe(0);
        expect(decisions[5]!.retryAfterMs).toBeGreaterThan(400);
        expect(decisions[5]!.retryAfterMs).toBeLessThanOrEqual(500);
    });

    it("refills at the configured rate", async () => {
        for (let i = 0; i < 3; i++) await limiter.take("key", 3, 20);
        expect((await limiter.take("key", 3, 20)).allowed).toBe(false);
        await new Promise((r) => setTimeout(r, 120));
        expect((await limiter.take("key", 3, 20)).allowed).toBe(true);
    });

    it("never grants more than the burst under concurrent requests", async () => {
        const decisions = await Promise.all(Array.from({ length: 50 }, () => limiter.take("key", 10, 0.001)));
        expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
    });

    it("keeps separate buckets per key", async () => {
        await limiter.take("a", 1, 0.001);
        expect((await limiter.take("a", 1, 0.001)).allowed).toBe(false);
        expect((await limiter.take("b", 1, 0.001)).allowed).toBe(true);
    });
});

describe("FailOpenRateLimiter", () => {
    it("allows requests when the backing store fails", async () => {
        const errors: unknown[] = [];
        const broken: RateLimiter = { take: () => Promise.reject(new Error("connection refused")) };
        const decision = await new FailOpenRateLimiter(broken, (e) => errors.push(e)).take("key", 5, 1);
        expect(decision.allowed).toBe(true);
        expect(errors).toHaveLength(1);
    });
});

describe("API rate limiting", () => {
    it("returns 429 with Retry-After once a key's bucket is empty", async () => {
        await resetDatabase(pool);
        const account = await createAccount(pool, { rateBurst: 2, ratePerSec: 1 });
        const app = testApp(pool, limiter);
        const send = () => app.inject({ method: "POST", url: "/emails", headers: auth(account), payload: email() });

        const [a, b, c] = [await send(), await send(), await send()];
        expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 429]);
        expect(b.headers["ratelimit-remaining"]).toBe("0");
        expect(c.headers["retry-after"]).toBe("1");
        expect(c.json()).toMatchObject({ name: "rate_limit_exceeded" });
        expect((await pool.query("SELECT count(*)::int AS n FROM emails")).rows[0].n).toBe(2);
    });
});
