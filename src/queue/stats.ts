import type { Queryable } from "../db/pool.ts";

export interface QueueStats {
    queued: number;
    sending: number;
    oldestDueAgeSeconds: number;
    deadLastHour: number;
}

/** Inputs for the queue-age and dead-letter alarms in infra/alarms.tf. */
export async function queueStats(db: Queryable): Promise<QueueStats> {
    const { rows } = await db.query<{ queued: number; sending: number; oldest: number; dead: number }>(`
        SELECT
            count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'sending')::int AS sending,
            coalesce(extract(epoch FROM now() - min(available_at) FILTER (WHERE status = 'queued' AND available_at <= now())), 0)::float8 AS oldest,
            (SELECT count(*)::int FROM deliveries WHERE status = 'dead' AND updated_at > now() - interval '1 hour') AS dead
        FROM deliveries
        WHERE status IN ('queued', 'sending')`);
    const row = rows[0]!;
    return { queued: row.queued, sending: row.sending, oldestDueAgeSeconds: Math.round(row.oldest), deadLastHour: row.dead };
}

/**
 * CloudWatch Embedded Metric Format: a JSON log line that CloudWatch Logs turns
 * into metrics, so the worker needs no metrics client or extra IAM permissions.
 */
export function toEmf(stats: QueueStats, namespace = "MailRelay"): string {
    return JSON.stringify({
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
                {
                    Namespace: namespace,
                    Dimensions: [[]],
                    Metrics: [
                        { Name: "QueueDepth", Unit: "Count" },
                        { Name: "InFlight", Unit: "Count" },
                        { Name: "OldestDueAgeSeconds", Unit: "Seconds" },
                        { Name: "DeadLastHour", Unit: "Count" },
                    ],
                },
            ],
        },
        QueueDepth: stats.queued,
        InFlight: stats.sending,
        OldestDueAgeSeconds: stats.oldestDueAgeSeconds,
        DeadLastHour: stats.deadLastHour,
    });
}
