import { createHash } from "node:crypto";
import { withTransaction, type Pool, type PoolClient } from "../db/pool.ts";
import { ApiError } from "./errors.ts";

export interface StoredResponse {
    status: number;
    body: unknown;
}

export interface IdempotentResult extends StoredResponse {
    replayed: boolean;
}

export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * Runs `handler` at most once per (team, key) while the key is live.
 *
 * The key row is inserted first, in the same transaction as the work. A
 * concurrent request with the same key blocks on that insert until the first
 * transaction commits, then reads the stored response instead of doing the
 * work again. If the first transaction rolls back, nothing was stored and the
 * waiting request takes the key itself. Expired keys are taken over in place.
 */
export async function runIdempotent(
    pool: Pool,
    scope: { teamId: string; key: string; requestHash: Buffer; ttlSeconds?: number },
    handler: (client: PoolClient) => Promise<StoredResponse>,
): Promise<IdempotentResult> {
    return withTransaction(pool, async (client) => {
        const claimed = await client.query(
            `INSERT INTO idempotency_keys (team_id, key, request_hash, expires_at)
             VALUES ($1, $2, $3, now() + make_interval(secs => $4))
             ON CONFLICT (team_id, key) DO UPDATE
                SET request_hash = EXCLUDED.request_hash, response_status = NULL, response_body = NULL,
                    created_at = now(), expires_at = EXCLUDED.expires_at
                WHERE idempotency_keys.expires_at <= now()
             RETURNING 1`,
            [scope.teamId, scope.key, scope.requestHash, scope.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS],
        );

        if (claimed.rowCount === 1) {
            const response = await handler(client);
            await client.query(
                "UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE team_id = $1 AND key = $2",
                [scope.teamId, scope.key, response.status, JSON.stringify(response.body)],
            );
            return { ...response, replayed: false };
        }

        const { rows } = await client.query<{ request_hash: Buffer; response_status: number; response_body: unknown }>(
            "SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE team_id = $1 AND key = $2",
            [scope.teamId, scope.key],
        );
        const stored = rows[0]!;
        if (!stored.request_hash.equals(scope.requestHash)) {
            throw new ApiError(409, "invalid_idempotent_request", "This idempotency key was already used with a different request body.");
        }
        return { status: stored.response_status, body: stored.response_body, replayed: true };
    });
}

/** Hashes the route and body. Key order in the body doesn't change the hash. */
export function hashRequest(route: string, body: unknown): Buffer {
    return createHash("sha256").update(route).update("\n").update(canonicalJson(body)).digest();
}

export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

export async function deleteExpiredKeys(pool: Pool, limit = 10_000): Promise<number> {
    const { rowCount } = await pool.query(
        `DELETE FROM idempotency_keys WHERE ctid IN (
            SELECT ctid FROM idempotency_keys WHERE expires_at <= now() LIMIT $1
         )`,
        [limit],
    );
    return rowCount ?? 0;
}
