import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import { addDomain, createApiKey, createTeam } from "../../src/accounts/repository.ts";
import { buildApp } from "../../src/api/app.ts";
import { RedisTokenBucket, type RateLimiter } from "../../src/api/rate-limit.ts";
import type { Pool } from "../../src/db/pool.ts";

export const REDIS_URL = process.env.MAILRELAY_TEST_REDIS_URL ?? "redis://localhost:6379";

export interface TestAccount {
    teamId: string;
    apiKeyId: string;
    token: string;
}

export async function createAccount(pool: Pool, options: { rateBurst?: number; ratePerSec?: number } = {}): Promise<TestAccount> {
    const teamId = await createTeam(pool, "acme");
    const key = await createApiKey(pool, teamId, { rateBurst: options.rateBurst ?? 10_000, ratePerSec: options.ratePerSec ?? 10_000 });
    await addDomain(pool, teamId, "acme.test", true);
    await addDomain(pool, teamId, "unverified.test", false);
    return { teamId, apiKeyId: key.id, token: key.token };
}

export function testRedis(): Redis {
    return new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
}

/** A rate limiter with its own key space, so test runs never share buckets. */
export function isolatedLimiter(redis: Redis): RateLimiter {
    return new RedisTokenBucket(redis, `test:${randomUUID()}:`);
}

export function testApp(pool: Pool, rateLimiter: RateLimiter, idempotencyTtlSeconds?: number): FastifyInstance {
    return buildApp({ pool, rateLimiter, ...(idempotencyTtlSeconds !== undefined && { idempotencyTtlSeconds }) });
}

export function auth(account: TestAccount, extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${account.token}`, ...extra };
}

export const email = (overrides: Record<string, unknown> = {}) => ({
    from: "Acme <hello@acme.test>",
    to: ["ana@example.test"],
    subject: "Your receipt",
    text: "Thanks for your order.",
    ...overrides,
});
