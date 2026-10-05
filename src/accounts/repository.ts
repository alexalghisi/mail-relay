import { randomBytes } from "node:crypto";
import type { Queryable } from "../db/pool.ts";
import { displayPrefix, generateApiToken, hashApiToken } from "./api-keys.ts";

export interface ApiKeyRecord {
    id: string;
    teamId: string;
    rateBurst: number;
    ratePerSec: number;
}

export interface NewApiKey {
    id: string;
    token: string;
}

export async function createTeam(db: Queryable, name: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>("INSERT INTO teams (name) VALUES ($1) RETURNING id", [name]);
    return rows[0]!.id;
}

export async function createApiKey(
    db: Queryable,
    teamId: string,
    options: { name?: string; rateBurst?: number; ratePerSec?: number } = {},
): Promise<NewApiKey> {
    const token = generateApiToken();
    const { rows } = await db.query<{ id: string }>(
        `INSERT INTO api_keys (team_id, name, token_hash, token_prefix, rate_burst, rate_per_sec)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [teamId, options.name ?? "default", hashApiToken(token), displayPrefix(token), options.rateBurst ?? 20, options.ratePerSec ?? 10],
    );
    return { id: rows[0]!.id, token };
}

export async function findApiKey(db: Queryable, token: string): Promise<ApiKeyRecord | undefined> {
    const { rows } = await db.query<{ id: string; team_id: string; rate_burst: number; rate_per_sec: string }>(
        "SELECT id, team_id, rate_burst, rate_per_sec FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL",
        [hashApiToken(token)],
    );
    const row = rows[0];
    return row && { id: row.id, teamId: row.team_id, rateBurst: row.rate_burst, ratePerSec: Number(row.rate_per_sec) };
}

export async function addDomain(db: Queryable, teamId: string, name: string, verified: boolean): Promise<void> {
    await db.query(
        `INSERT INTO domains (team_id, name, verified_at) VALUES ($1, lower($2), CASE WHEN $3 THEN now() END)
         ON CONFLICT (team_id, name) DO UPDATE SET verified_at = EXCLUDED.verified_at`,
        [teamId, name, verified],
    );
}

export async function isVerifiedDomain(db: Queryable, teamId: string, name: string): Promise<boolean> {
    const { rowCount } = await db.query(
        "SELECT 1 FROM domains WHERE team_id = $1 AND name = lower($2) AND verified_at IS NOT NULL",
        [teamId, name],
    );
    return rowCount === 1;
}

export async function createWebhookEndpoint(
    db: Queryable,
    teamId: string,
    url: string,
    eventTypes: string[] = [],
): Promise<{ id: string; secret: string }> {
    const secret = "whsec_" + randomBytes(24).toString("base64");
    const { rows } = await db.query<{ id: string }>(
        "INSERT INTO webhook_endpoints (team_id, url, secret, event_types) VALUES ($1, $2, $3, $4) RETURNING id",
        [teamId, url, secret, eventTypes],
    );
    return { id: rows[0]!.id, secret };
}

export async function setDomainConcurrency(db: Queryable, domain: string, maxConcurrency: number): Promise<void> {
    await db.query(
        `INSERT INTO recipient_domain_limits (domain, max_concurrency) VALUES ($1, $2)
         ON CONFLICT (domain) DO UPDATE SET max_concurrency = EXCLUDED.max_concurrency`,
        [domain, maxConcurrency],
    );
}
