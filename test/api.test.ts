import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { addDomain, createApiKey, createTeam } from "../src/accounts/repository.ts";
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

describe("authentication", () => {
    it("requires an API key", async () => {
        const res = await app.inject({ method: "POST", url: "/emails", payload: email() });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ name: "missing_api_key" });
    });

    it("rejects unknown keys", async () => {
        const res = await app.inject({ method: "POST", url: "/emails", payload: email(), headers: { authorization: "Bearer mr_nope" } });
        expect(res.statusCode).toBe(403);
    });

    it("stores only a hash of the key", async () => {
        const { rows } = await pool.query("SELECT token_hash, token_prefix FROM api_keys");
        expect(rows[0].token_hash).toBeInstanceOf(Buffer);
        expect(account.token.startsWith(rows[0].token_prefix)).toBe(true);
        expect(rows[0].token_hash.toString("utf8")).not.toContain(account.token);
    });
});

describe("POST /emails", () => {
    it("queues one delivery per unique recipient and records email.sent", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/emails",
            headers: auth(account),
            payload: email({ to: ["ana@example.test", "ANA@example.test", "bo@other.test"], tags: [{ name: "category", value: "receipt" }] }),
        });
        expect(res.statusCode).toBe(200);
        const { id } = res.json();

        const deliveries = await pool.query("SELECT recipient, recipient_domain, status FROM deliveries WHERE email_id = $1 ORDER BY id", [id]);
        expect(deliveries.rows).toEqual([
            { recipient: "ana@example.test", recipient_domain: "example.test", status: "queued" },
            { recipient: "bo@other.test", recipient_domain: "other.test", status: "queued" },
        ]);

        const view = await app.inject({ method: "GET", url: `/emails/${id}`, headers: auth(account) });
        expect(view.json()).toMatchObject({
            id,
            from: "Acme <hello@acme.test>",
            last_event: "email.sent",
            tags: [{ name: "category", value: "receipt" }],
            events: [{ type: "email.sent" }],
        });
    });

    it("accepts a single recipient as a string", async () => {
        const res = await app.inject({ method: "POST", url: "/emails", headers: auth(account), payload: email({ to: "ana@example.test" }) });
        expect(res.statusCode).toBe(200);
    });

    it.each([
        ["an unverified domain", "hello@unverified.test"],
        ["a domain the team never added", "hello@elsewhere.test"],
    ])("rejects a sender on %s", async (_case, from) => {
        const res = await app.inject({ method: "POST", url: "/emails", headers: auth(account), payload: email({ from }) });
        expect(res.statusCode).toBe(403);
        expect(res.json().message).toMatch(/domain is not verified/);
        expect((await pool.query("SELECT count(*)::int AS n FROM emails")).rows[0].n).toBe(0);
    });

    it("does not accept another team's verified domain", async () => {
        const otherTeam = await createTeam(pool, "other");
        await addDomain(pool, otherTeam, "other.test", true);
        const res = await app.inject({ method: "POST", url: "/emails", headers: auth(account), payload: email({ from: "x@other.test" }) });
        expect(res.statusCode).toBe(403);
    });

    it.each([
        ["no body", { text: undefined }],
        ["a bad recipient", { to: ["not-an-address"] }],
        ["too many recipients", { to: Array.from({ length: 51 }, (_, i) => `u${i}@example.test`) }],
        ["an unknown field", { cc: ["x@example.test"] }],
        ["a bad tag", { tags: [{ name: "has space", value: "x" }] }],
    ])("returns 422 for %s", async (_case, overrides) => {
        const res = await app.inject({ method: "POST", url: "/emails", headers: auth(account), payload: email(overrides) });
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({ name: "validation_error" });
    });

    it("returns 400 for malformed JSON", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/emails",
            headers: auth(account, { "content-type": "application/json" }),
            payload: "{nope",
        });
        expect(res.statusCode).toBe(400);
    });
});

describe("GET /emails/:id", () => {
    it("hides emails from other teams", async () => {
        const created = await app.inject({ method: "POST", url: "/emails", headers: auth(account), payload: email() });
        const otherTeam = await createTeam(pool, "other");
        const other = await createApiKey(pool, otherTeam);
        const res = await app.inject({ method: "GET", url: `/emails/${created.json().id}`, headers: { authorization: `Bearer ${other.token}` } });
        expect(res.statusCode).toBe(404);
    });

    it("returns 404 for ids that are not UUIDs", async () => {
        const res = await app.inject({ method: "GET", url: "/emails/abc", headers: auth(account) });
        expect(res.statusCode).toBe(404);
    });
});
