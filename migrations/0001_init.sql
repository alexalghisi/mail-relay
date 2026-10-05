CREATE TABLE teams (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id      uuid NOT NULL REFERENCES teams (id),
    name         text NOT NULL,
    -- SHA-256 of the full token. Tokens are 32 random bytes, so a fast hash is
    -- enough; a slow KDF would only add latency to every request.
    token_hash   bytea NOT NULL UNIQUE,
    token_prefix text NOT NULL,
    -- Token bucket parameters for this key.
    rate_burst   integer NOT NULL DEFAULT 20 CHECK (rate_burst > 0),
    rate_per_sec numeric NOT NULL DEFAULT 10 CHECK (rate_per_sec > 0),
    created_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz
);

CREATE TABLE domains (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     uuid NOT NULL REFERENCES teams (id),
    name        text NOT NULL CHECK (name = lower(name)),
    verified_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (team_id, name)
);

CREATE TABLE emails (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     uuid NOT NULL REFERENCES teams (id),
    api_key_id  uuid NOT NULL REFERENCES api_keys (id),
    from_header text NOT NULL,
    from_email  text NOT NULL,
    recipients  text[] NOT NULL,
    subject     text NOT NULL,
    html        text,
    text_body   text,
    tags        jsonb NOT NULL DEFAULT '[]',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX emails_team_id_created_at_idx ON emails (team_id, created_at DESC);

-- One row per recipient, so each recipient is retried, bounced and
-- rate-limited on its own and per-domain concurrency can be enforced.
CREATE TABLE deliveries (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email_id           uuid NOT NULL REFERENCES emails (id),
    recipient          text NOT NULL,
    recipient_domain   text NOT NULL,
    status             text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'sending', 'delivered', 'bounced', 'dead')),
    attempts           integer NOT NULL DEFAULT 0,
    max_attempts       integer NOT NULL DEFAULT 8,
    -- For queued rows: when the row may be picked up. For sending rows: when
    -- the lease expires and another worker may take it over.
    available_at       timestamptz NOT NULL DEFAULT now(),
    lease_owner        text,
    lease_token        uuid,
    last_smtp_code     integer,
    last_smtp_response text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (email_id, recipient)
);

CREATE TABLE recipient_domain_limits (
    domain          text PRIMARY KEY,
    max_concurrency integer NOT NULL CHECK (max_concurrency > 0)
);

CREATE TABLE events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id    uuid NOT NULL REFERENCES emails (id),
    delivery_id bigint REFERENCES deliveries (id),
    type        text NOT NULL,
    payload     jsonb NOT NULL DEFAULT '{}',
    -- Recording the same state transition twice is a no-op.
    dedupe_key  text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX events_email_id_created_at_idx ON events (email_id, created_at);

CREATE TABLE webhook_endpoints (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     uuid NOT NULL REFERENCES teams (id),
    url         text NOT NULL,
    secret      text NOT NULL,
    -- Empty means every event type.
    event_types text[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz
);

CREATE TABLE webhook_messages (
    id               text PRIMARY KEY,
    event_id         uuid NOT NULL REFERENCES events (id),
    endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints (id),
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts         integer NOT NULL DEFAULT 0,
    available_at     timestamptz NOT NULL DEFAULT now(),
    last_status_code integer,
    last_error       text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    delivered_at     timestamptz,
    UNIQUE (event_id, endpoint_id)
);

CREATE INDEX webhook_messages_pending_idx ON webhook_messages (available_at) WHERE status = 'pending';

CREATE TABLE idempotency_keys (
    team_id         uuid NOT NULL REFERENCES teams (id),
    key             text NOT NULL,
    request_hash    bytea NOT NULL,
    -- Filled in by the same transaction that inserts the key, so other
    -- sessions never observe them as NULL.
    response_status integer,
    response_body   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    PRIMARY KEY (team_id, key)
);

CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);
