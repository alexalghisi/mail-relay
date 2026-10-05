import type { Queryable } from "../db/pool.ts";
import { silentLogger, type Logger } from "../log.ts";
import { ClaimLoop } from "../queue/claim-loop.ts";
import { signedHeaders } from "./signing.ts";

export interface WebhookMessage {
    id: string;
    attempt: number;
    url: string;
    secret: string;
    body: string;
}

export interface DispatcherOptions {
    db: Queryable;
    concurrency?: number;
    maxAttempts?: number;
    leaseSeconds?: number;
    timeoutMs?: number;
    retryBaseMs?: number;
    retryCapMs?: number;
    idleMs?: number;
    logger?: Logger;
    fetch?: typeof fetch;
}

/**
 * Delivers recorded events to customer endpoints, at least once.
 *
 * Messages are leased with SKIP LOCKED like deliveries. The attempt counter
 * doubles as the fencing token: a dispatcher can only settle the attempt it
 * claimed. The webhook-id stays the same across retries so receivers can
 * drop duplicates.
 */
export class WebhookDispatcher {
    private readonly db: Queryable;
    private readonly log: Logger;
    private readonly loop: ClaimLoop<WebhookMessage>;
    private readonly maxAttempts: number;
    private readonly leaseSeconds: number;
    private readonly timeoutMs: number;
    private readonly retryBaseMs: number;
    private readonly retryCapMs: number;
    private readonly fetch: typeof fetch;

    constructor(options: DispatcherOptions) {
        this.db = options.db;
        this.log = options.logger ?? silentLogger;
        this.maxAttempts = options.maxAttempts ?? 8;
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.leaseSeconds = options.leaseSeconds ?? Math.ceil((this.timeoutMs * 3) / 1000);
        this.retryBaseMs = options.retryBaseMs ?? 5_000;
        this.retryCapMs = options.retryCapMs ?? 6 * 60 * 60 * 1000;
        this.fetch = options.fetch ?? fetch;
        this.loop = new ClaimLoop({
            claim: (limit) => this.claim(limit),
            handle: (message) => this.deliver(message),
            concurrency: options.concurrency ?? 16,
            logger: this.log,
            ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
        });
    }

    start(): void {
        this.loop.start();
    }

    stop(timeoutMs?: number): Promise<void> {
        return this.loop.stop(timeoutMs);
    }

    async claim(limit: number): Promise<WebhookMessage[]> {
        const { rows } = await this.db.query<{
            id: string;
            attempts: number;
            url: string;
            secret: string;
            type: string;
            email_id: string;
            payload: Record<string, unknown>;
            created_at: Date;
        }>(
            `WITH due AS (
                SELECT id FROM webhook_messages
                WHERE status = 'pending' AND available_at <= now()
                ORDER BY available_at
                LIMIT $1
                FOR UPDATE SKIP LOCKED
             ), claimed AS (
                UPDATE webhook_messages m
                SET attempts = m.attempts + 1, available_at = now() + make_interval(secs => $2)
                FROM due WHERE m.id = due.id
                RETURNING m.id, m.attempts, m.event_id, m.endpoint_id
             )
             SELECT c.id, c.attempts, w.url, w.secret, e.type, e.email_id, e.payload, e.created_at
             FROM claimed c
             JOIN webhook_endpoints w ON w.id = c.endpoint_id
             JOIN events e ON e.id = c.event_id`,
            [limit, this.leaseSeconds],
        );
        return rows.map((r) => ({
            id: r.id,
            attempt: r.attempts,
            url: r.url,
            secret: r.secret,
            body: JSON.stringify({ type: r.type, created_at: r.created_at.toISOString(), data: { email_id: r.email_id, ...r.payload } }),
        }));
    }

    async deliver(message: WebhookMessage): Promise<void> {
        let status: number | null = null;
        let error: string | null = null;
        try {
            const response = await this.fetch(message.url, {
                method: "POST",
                headers: { "content-type": "application/json", ...signedHeaders(message.secret, message.id, message.body) },
                body: message.body,
                signal: AbortSignal.timeout(this.timeoutMs),
                redirect: "manual",
            });
            status = response.status;
            await response.body?.cancel();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }

        const fields = { id: message.id, url: message.url, attempt: message.attempt, status: status ?? undefined, err: error ?? undefined };
        if (status !== null && status >= 200 && status < 300) {
            await this.db.query(
                `UPDATE webhook_messages SET status = 'delivered', delivered_at = now(), last_status_code = $3, last_error = NULL
                 WHERE id = $1 AND attempts = $2 AND status = 'pending'`,
                [message.id, message.attempt, status],
            );
            this.log.info("webhook delivered", fields);
            return;
        }

        const { rows } = await this.db.query<{ status: string }>(
            `UPDATE webhook_messages
             SET status = CASE WHEN attempts >= $5 THEN 'failed' ELSE 'pending' END,
                 available_at = now() + retry_delay(attempts, $6, $7),
                 last_status_code = $3, last_error = $4
             WHERE id = $1 AND attempts = $2 AND status = 'pending'
             RETURNING status`,
            [message.id, message.attempt, status, error ?? `HTTP ${status}`, this.maxAttempts, this.retryBaseMs, this.retryCapMs],
        );
        this.log.warn(rows[0]?.status === "failed" ? "webhook failed, giving up" : "webhook failed, will retry", fields);
    }
}
