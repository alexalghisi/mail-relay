import { createPool, type Pool } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";

export const TEST_DATABASE_URL =
    process.env.MAILRELAY_TEST_DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/mailrelay_test";

let migrated = false;

export async function testPool(max = 10): Promise<Pool> {
    const pool = createPool(TEST_DATABASE_URL, max);
    if (!migrated) {
        await migrate(pool);
        migrated = true;
    }
    return pool;
}

export async function resetDatabase(pool: Pool): Promise<void> {
    await pool.query(`
        TRUNCATE teams, api_keys, domains, emails, deliveries, recipient_domain_limits,
                 events, webhook_endpoints, webhook_messages, idempotency_keys
        RESTART IDENTITY CASCADE`);
}

/** Inserts an email with one queued delivery per recipient, bypassing the API. */
export async function insertEmail(
    pool: Pool,
    teamId: string,
    apiKeyId: string,
    recipients: string[],
    options: { maxAttempts?: number; subject?: string } = {},
): Promise<{ emailId: string; deliveryIds: number[] }> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO emails (team_id, api_key_id, from_header, from_email, recipients, subject, text_body)
         VALUES ($1, $2, 'Acme <hello@acme.test>', 'hello@acme.test', $3, $4, 'hi') RETURNING id`,
        [teamId, apiKeyId, recipients, options.subject ?? "Hello"],
    );
    const emailId = rows[0]!.id;
    const deliveries = await pool.query<{ id: number }>(
        `INSERT INTO deliveries (email_id, recipient, recipient_domain, max_attempts)
         SELECT $1, r, split_part(r, '@', 2), $3 FROM unnest($2::text[]) r
         RETURNING id`,
        [emailId, recipients, options.maxAttempts ?? 8],
    );
    return { emailId, deliveryIds: deliveries.rows.map((r) => r.id) };
}
