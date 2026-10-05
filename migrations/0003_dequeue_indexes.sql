-- migrate: no-transaction
--
-- Built concurrently so the migration doesn't block inserts into a live
-- deliveries table. Both indexes are partial: delivered, bounced and dead rows
-- are the vast majority and are never looked at by the queue, so they stay
-- out of the index and it stays small no matter how much history accumulates.

-- Dequeue: the oldest due row among queued and leased rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS deliveries_dequeue_idx
    ON deliveries (available_at)
    WHERE status IN ('queued', 'sending');

-- Live leases per domain, counted on every claim.
CREATE INDEX CONCURRENTLY IF NOT EXISTS deliveries_in_flight_idx
    ON deliveries (recipient_domain)
    WHERE status = 'sending';
