import type { Queryable } from "../db/pool.ts";
import type { Mailbox } from "./address.ts";

export interface NewEmail {
    teamId: string;
    apiKeyId: string;
    from: Mailbox;
    recipients: string[];
    subject: string;
    html: string | undefined;
    text: string | undefined;
    tags: { name: string; value: string }[];
}

/** Inserts the email, one queued delivery per recipient and the email.sent event. */
export async function insertEmail(db: Queryable, email: NewEmail): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
        `WITH e AS (
            INSERT INTO emails (team_id, api_key_id, from_header, from_email, recipients, subject, html, text_body, tags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
         ), d AS (
            INSERT INTO deliveries (email_id, recipient, recipient_domain)
            SELECT e.id, r, split_part(r, '@', 2) FROM e, unnest($5::text[]) r
         )
         SELECT id FROM e`,
        [
            email.teamId,
            email.apiKeyId,
            email.from.header,
            email.from.email,
            email.recipients,
            email.subject,
            email.html ?? null,
            email.text ?? null,
            JSON.stringify(email.tags),
        ],
    );
    const id = rows[0]!.id;
    await db.query("SELECT record_event($1::uuid, NULL, 'email.sent', $2, 'sent:' || $1::text)", [
        id,
        JSON.stringify({ from: email.from.header, to: email.recipients, subject: email.subject }),
    ]);
    return id;
}

export interface EmailView {
    id: string;
    from: string;
    to: string[];
    subject: string;
    tags: { name: string; value: string }[];
    created_at: string;
    last_event: string | null;
    recipients: { email: string; status: string; attempts: number; smtp_response: string | null }[];
    events: { type: string; created_at: string; payload: Record<string, unknown> }[];
}

export async function findEmail(db: Queryable, teamId: string, id: string): Promise<EmailView | undefined> {
    const email = await db.query<{ id: string; from_header: string; recipients: string[]; subject: string; tags: EmailView["tags"]; created_at: Date }>(
        "SELECT id, from_header, recipients, subject, tags, created_at FROM emails WHERE id = $1 AND team_id = $2",
        [id, teamId],
    );
    const row = email.rows[0];
    if (!row) return undefined;

    const [deliveries, events] = await Promise.all([
        db.query<{ recipient: string; status: string; attempts: number; last_smtp_response: string | null }>(
            "SELECT recipient, status, attempts, last_smtp_response FROM deliveries WHERE email_id = $1 ORDER BY id",
            [id],
        ),
        db.query<{ type: string; created_at: Date; payload: Record<string, unknown> }>(
            "SELECT type, created_at, payload FROM events WHERE email_id = $1 ORDER BY created_at, id",
            [id],
        ),
    ]);

    return {
        id: row.id,
        from: row.from_header,
        to: row.recipients,
        subject: row.subject,
        tags: row.tags,
        created_at: row.created_at.toISOString(),
        last_event: events.rows.at(-1)?.type ?? null,
        recipients: deliveries.rows.map((d) => ({
            email: d.recipient,
            status: d.status,
            attempts: d.attempts,
            smtp_response: d.last_smtp_response,
        })),
        events: events.rows.map((e) => ({ type: e.type, created_at: e.created_at.toISOString(), payload: e.payload })),
    };
}
