-- The delivery queue contract. Both the TypeScript and the Go worker call
-- these functions instead of carrying their own copies of the SQL, so lease,
-- retry and event rules can't drift between the two implementations.

-- Records an event once per dedupe key and fans it out to the team's webhook
-- endpoints. Returns NULL when the event was already recorded.
CREATE FUNCTION record_event(
    p_email_id uuid,
    p_delivery_id bigint,
    p_type text,
    p_payload jsonb,
    p_dedupe_key text
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
    v_event_id uuid;
BEGIN
    INSERT INTO events (email_id, delivery_id, type, payload, dedupe_key)
    VALUES (p_email_id, p_delivery_id, p_type, p_payload, p_dedupe_key)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NULL THEN
        RETURN NULL;
    END IF;

    INSERT INTO webhook_messages (id, event_id, endpoint_id)
    SELECT 'msg_' || replace(gen_random_uuid()::text, '-', ''), v_event_id, w.id
    FROM webhook_endpoints w
    JOIN emails e ON e.team_id = w.team_id
    WHERE e.id = p_email_id
      AND w.disabled_at IS NULL
      AND (cardinality(w.event_types) = 0 OR p_type = ANY (w.event_types))
    ON CONFLICT (event_id, endpoint_id) DO NOTHING;

    RETURN v_event_id;
END;
$$;

-- Exponential backoff with "equal jitter": somewhere between half and all of
-- min(cap, base * 2^(attempt-1)). Never zero, so a flapping server can't be
-- retried in a tight loop, and spread out so retries don't arrive in waves.
CREATE FUNCTION retry_delay(p_attempt integer, p_base_ms integer, p_cap_ms integer)
RETURNS interval
LANGUAGE sql VOLATILE AS $$
    SELECT make_interval(secs => d / 2000.0 + random() * d / 2000.0)
    FROM (SELECT least(p_cap_ms::float8, p_base_ms * power(2, greatest(p_attempt, 1) - 1)) AS d) s
$$;

CREATE FUNCTION domain_concurrency_limit(p_domain text, p_default integer)
RETURNS integer
LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT max_concurrency FROM recipient_domain_limits WHERE domain = p_domain), p_default)
$$;

-- Leases up to p_limit deliveries. A row is claimable when it is queued and
-- due, or when it is sending but its lease ran out (the worker died).
--
-- Per-domain concurrency is enforced across all workers: before taking a row
-- for a domain, the claimer takes a transaction-scoped advisory lock for that
-- domain and counts live leases. The lock is try-only, so two claimers never
-- wait on each other; a busy or saturated domain is skipped for this round and
-- the claimer moves on to other domains instead of stalling behind it.
CREATE FUNCTION claim_deliveries(
    p_worker text,
    p_limit integer,
    p_lease_seconds integer,
    p_default_domain_limit integer
) RETURNS TABLE (
    delivery_id bigint,
    email_id uuid,
    recipient text,
    attempt integer,
    lease_token uuid,
    from_header text,
    subject text,
    html text,
    text_body text
)
LANGUAGE plpgsql AS $$
DECLARE
    v_row deliveries%ROWTYPE;
    v_skip text[] := '{}';
    v_claimed bigint[] := '{}';
    v_in_flight integer;
BEGIN
    WHILE cardinality(v_claimed) < p_limit LOOP
        SELECT d.* INTO v_row
        FROM deliveries d
        WHERE d.status IN ('queued', 'sending')
          AND d.available_at <= now()
          AND d.recipient_domain <> ALL (v_skip)
        ORDER BY d.available_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED;

        EXIT WHEN NOT FOUND;

        -- A lease that expired on the last allowed attempt: the worker keeps
        -- dying on this message, so stop handing it out.
        IF v_row.status = 'sending' AND v_row.attempts >= v_row.max_attempts THEN
            UPDATE deliveries
            SET status = 'dead', lease_token = NULL, lease_owner = NULL, updated_at = now()
            WHERE id = v_row.id;
            PERFORM record_event(v_row.email_id, v_row.id, 'email.bounced',
                jsonb_build_object('to', v_row.recipient, 'bounce_type', 'transient',
                                   'reason', 'lease expired on final attempt'),
                'bounced:' || v_row.id);
            CONTINUE;
        END IF;

        IF NOT pg_try_advisory_xact_lock(hashtext('mailrelay.domain'), hashtext(v_row.recipient_domain)) THEN
            v_skip := v_skip || v_row.recipient_domain;
            CONTINUE;
        END IF;

        SELECT count(*) INTO v_in_flight
        FROM deliveries d
        WHERE d.recipient_domain = v_row.recipient_domain
          AND d.status = 'sending'
          AND d.available_at > now();

        IF v_in_flight >= domain_concurrency_limit(v_row.recipient_domain, p_default_domain_limit) THEN
            v_skip := v_skip || v_row.recipient_domain;
            CONTINUE;
        END IF;

        UPDATE deliveries
        SET status = 'sending',
            attempts = attempts + 1,
            lease_owner = p_worker,
            lease_token = gen_random_uuid(),
            available_at = now() + make_interval(secs => p_lease_seconds),
            updated_at = now()
        WHERE id = v_row.id;

        v_claimed := v_claimed || v_row.id;
    END LOOP;

    RETURN QUERY
    SELECT d.id, d.email_id, d.recipient, d.attempts, d.lease_token,
           e.from_header, e.subject, e.html, e.text_body
    FROM deliveries d
    JOIN emails e ON e.id = d.email_id
    WHERE d.id = ANY (v_claimed)
    ORDER BY d.id;
END;
$$;

-- Every transition below is fenced by the lease token: a worker whose lease
-- expired and was taken over can no longer change the row, so a slow worker
-- and its replacement can't both record an outcome.

CREATE FUNCTION complete_delivery(p_id bigint, p_token uuid, p_code integer, p_response text)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
    v_row deliveries%ROWTYPE;
BEGIN
    UPDATE deliveries
    SET status = 'delivered', lease_token = NULL, lease_owner = NULL,
        last_smtp_code = p_code, last_smtp_response = p_response, updated_at = now()
    WHERE id = p_id AND lease_token = p_token AND status = 'sending'
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    PERFORM record_event(v_row.email_id, v_row.id, 'email.delivered',
        jsonb_build_object('to', v_row.recipient, 'smtp_code', p_code, 'smtp_response', p_response),
        'delivered:' || v_row.id);
    RETURN true;
END;
$$;

-- Returns the new status ('queued', 'bounced' or 'dead'), or NULL when the
-- lease was lost.
CREATE FUNCTION fail_delivery(
    p_id bigint,
    p_token uuid,
    p_code integer,
    p_response text,
    p_permanent boolean,
    p_retry_base_ms integer,
    p_retry_cap_ms integer
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_row deliveries%ROWTYPE;
    v_status text;
BEGIN
    SELECT * INTO v_row FROM deliveries
    WHERE id = p_id AND lease_token = p_token AND status = 'sending'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_status := CASE
        WHEN p_permanent THEN 'bounced'
        WHEN v_row.attempts >= v_row.max_attempts THEN 'dead'
        ELSE 'queued'
    END;

    UPDATE deliveries
    SET status = v_status,
        lease_token = NULL,
        lease_owner = NULL,
        last_smtp_code = p_code,
        last_smtp_response = p_response,
        available_at = CASE WHEN v_status = 'queued'
                            THEN now() + retry_delay(v_row.attempts, p_retry_base_ms, p_retry_cap_ms)
                            ELSE available_at END,
        updated_at = now()
    WHERE id = p_id;

    IF v_status = 'queued' THEN
        PERFORM record_event(v_row.email_id, v_row.id, 'email.delivery_delayed',
            jsonb_build_object('to', v_row.recipient, 'attempt', v_row.attempts,
                               'smtp_code', p_code, 'smtp_response', p_response),
            'delayed:' || v_row.id || ':' || v_row.attempts);
    ELSE
        PERFORM record_event(v_row.email_id, v_row.id, 'email.bounced',
            jsonb_build_object('to', v_row.recipient,
                               'bounce_type', CASE WHEN p_permanent THEN 'permanent' ELSE 'transient' END,
                               'attempts', v_row.attempts,
                               'smtp_code', p_code, 'smtp_response', p_response),
            'bounced:' || v_row.id);
    END IF;

    RETURN v_status;
END;
$$;
