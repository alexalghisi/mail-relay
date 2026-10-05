import type { Queryable } from "../db/pool.ts";
import type { Outcome } from "../smtp/classify.ts";

export interface ClaimedDelivery {
    id: number;
    emailId: string;
    recipient: string;
    attempt: number;
    leaseToken: string;
    fromHeader: string;
    subject: string;
    html: string | null;
    textBody: string | null;
}

export interface QueueOptions {
    leaseSeconds: number;
    defaultDomainConcurrency: number;
    retryBaseMs: number;
    retryCapMs: number;
}

export type Settled = "delivered" | "queued" | "bounced" | "dead" | "lease_lost";

/** Thin wrapper over the SQL queue contract in migrations/0002_queue_contract.sql. */
export class DeliveryQueue {
    private readonly db: Queryable;
    private readonly options: QueueOptions;

    constructor(db: Queryable, options: QueueOptions) {
        this.db = db;
        this.options = options;
    }

    async claim(workerId: string, limit: number): Promise<ClaimedDelivery[]> {
        const { rows } = await this.db.query<{
            delivery_id: number;
            email_id: string;
            recipient: string;
            attempt: number;
            lease_token: string;
            from_header: string;
            subject: string;
            html: string | null;
            text_body: string | null;
        }>("SELECT * FROM claim_deliveries($1, $2, $3, $4)", [
            workerId,
            limit,
            this.options.leaseSeconds,
            this.options.defaultDomainConcurrency,
        ]);
        return rows.map((r) => ({
            id: r.delivery_id,
            emailId: r.email_id,
            recipient: r.recipient,
            attempt: r.attempt,
            leaseToken: r.lease_token,
            fromHeader: r.from_header,
            subject: r.subject,
            html: r.html,
            textBody: r.text_body,
        }));
    }

    async settle(delivery: ClaimedDelivery, outcome: Outcome): Promise<Settled> {
        if (outcome.kind === "delivered") {
            const { rows } = await this.db.query<{ ok: boolean }>("SELECT complete_delivery($1, $2, $3, $4) AS ok", [
                delivery.id,
                delivery.leaseToken,
                outcome.code,
                outcome.response,
            ]);
            return rows[0]?.ok ? "delivered" : "lease_lost";
        }
        const { rows } = await this.db.query<{ status: Settled | null }>(
            "SELECT fail_delivery($1, $2, $3, $4, $5, $6, $7) AS status",
            [
                delivery.id,
                delivery.leaseToken,
                outcome.code,
                outcome.response,
                outcome.kind === "permanent",
                this.options.retryBaseMs,
                this.options.retryCapMs,
            ],
        );
        return rows[0]?.status ?? "lease_lost";
    }
}
