import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey, createTeam } from "../src/accounts/repository.ts";
import type { Pool } from "../src/db/pool.ts";
import { queueStats, toEmf } from "../src/queue/stats.ts";
import { insertEmail, resetDatabase, testPool } from "./helpers/db.ts";

let pool: Pool;

beforeAll(async () => {
    pool = await testPool();
});
afterAll(async () => {
    await pool.end();
});
beforeEach(async () => {
    await resetDatabase(pool);
});

describe("queueStats", () => {
    it("reports depth, leases, the oldest due row and recent dead letters", async () => {
        const teamId = await createTeam(pool, "acme");
        const apiKeyId = (await createApiKey(pool, teamId)).id;
        const { deliveryIds } = await insertEmail(pool, teamId, apiKeyId, ["a@x.test", "b@x.test", "c@x.test", "d@x.test"]);
        await pool.query("UPDATE deliveries SET available_at = now() - interval '90 seconds' WHERE id = $1", [deliveryIds[0]]);
        await pool.query("UPDATE deliveries SET available_at = now() + interval '1 hour' WHERE id = $1", [deliveryIds[1]]);
        await pool.query("UPDATE deliveries SET status = 'sending' WHERE id = $1", [deliveryIds[2]]);
        await pool.query("UPDATE deliveries SET status = 'dead' WHERE id = $1", [deliveryIds[3]]);

        const stats = await queueStats(pool);
        expect(stats).toMatchObject({ queued: 2, sending: 1, deadLastHour: 1 });
        expect(stats.oldestDueAgeSeconds).toBeGreaterThanOrEqual(90);
        expect(stats.oldestDueAgeSeconds).toBeLessThan(95);
    });

    it("formats stats as CloudWatch embedded metrics", () => {
        const line = JSON.parse(toEmf({ queued: 3, sending: 1, oldestDueAgeSeconds: 12, deadLastHour: 0 }));
        expect(line._aws.CloudWatchMetrics[0].Namespace).toBe("MailRelay");
        expect(line).toMatchObject({ QueueDepth: 3, InFlight: 1, OldestDueAgeSeconds: 12, DeadLastHour: 0 });
    });
});
