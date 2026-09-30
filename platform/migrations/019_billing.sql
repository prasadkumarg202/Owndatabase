-- Billing (opt-in with BILLING_ENABLED; see docs/billing.md).
-- Amounts are in the currency's minor unit (cents / paise).

CREATE TABLE IF NOT EXISTS control_plane.plans (
    id              VARCHAR(40) PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'usd',
    price_monthly   BIGINT NOT NULL DEFAULT 0,
    max_projects    INTEGER,                                 -- NULL = unlimited
    project_limits  JSONB NOT NULL DEFAULT '{}',             -- keys as in platform/shared/limits.ts
    included        JSONB NOT NULL DEFAULT '{}',             -- per month: api_requests, function_invocations, storage_gb, database_gb
    overage         JSONB NOT NULL DEFAULT '{}',             -- api_requests_per_1k, function_invocations_per_1k, storage_gb, database_gb
    is_public       BOOLEAN NOT NULL DEFAULT TRUE,
    sort            INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO control_plane.plans (id, name, currency, price_monthly, max_projects, project_limits, included, overage, sort) VALUES
  ('free', 'Free', 'usd', 0, 2,
   '{"api_requests_per_day": 50000, "function_invocations_per_day": 20000, "storage_bytes": 1073741824, "database_bytes": 524288000, "auth_users": 50000, "realtime_connections": 200}',
   '{}', '{}', 0),
  ('pro', 'Pro', 'usd', 2500, 10,
   '{"storage_bytes": 107374182400, "database_bytes": 8589934592, "realtime_connections": 1000}',
   '{"api_requests": 5000000, "function_invocations": 2000000, "storage_gb": 100, "database_gb": 8}',
   '{"api_requests_per_1k": 5, "function_invocations_per_1k": 10, "storage_gb": 3, "database_gb": 13}', 1),
  ('team', 'Team', 'usd', 59900, NULL,
   '{"realtime_connections": 5000}',
   '{"api_requests": 50000000, "function_invocations": 20000000, "storage_gb": 500, "database_gb": 50}',
   '{"api_requests_per_1k": 4, "function_invocations_per_1k": 8, "storage_gb": 2, "database_gb": 10}', 2)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.subscriptions (
    organization_id          UUID PRIMARY KEY REFERENCES control_plane.organizations(id) ON DELETE CASCADE,
    plan_id                  VARCHAR(40) NOT NULL REFERENCES control_plane.plans(id),
    pending_plan_id          VARCHAR(40) REFERENCES control_plane.plans(id),   -- upgrade waiting for payment
    status                   VARCHAR(20) NOT NULL DEFAULT 'active',          -- active | past_due | canceled
    cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
    current_period_start     DATE NOT NULL DEFAULT date_trunc('month', NOW())::date,
    current_period_end       DATE NOT NULL DEFAULT (date_trunc('month', NOW()) + INTERVAL '1 month')::date,
    provider                 VARCHAR(20) NOT NULL DEFAULT 'manual',
    billing_email            VARCHAR(255),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS control_plane.usage_daily (
    project_id            UUID NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    organization_id       UUID NOT NULL,
    day                   DATE NOT NULL,
    api_requests          BIGINT NOT NULL DEFAULT 0,
    function_invocations  BIGINT NOT NULL DEFAULT 0,
    storage_bytes         BIGINT NOT NULL DEFAULT 0,
    database_bytes        BIGINT NOT NULL DEFAULT 0,
    auth_users            INTEGER NOT NULL DEFAULT 0,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, day)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_org_day ON control_plane.usage_daily (organization_id, day);

CREATE TABLE IF NOT EXISTS control_plane.invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES control_plane.organizations(id) ON DELETE CASCADE,
    number          VARCHAR(40) NOT NULL UNIQUE,
    kind            VARCHAR(20) NOT NULL DEFAULT 'period',     -- period | upgrade
    plan_id         VARCHAR(40) REFERENCES control_plane.plans(id),
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    currency        CHAR(3) NOT NULL,
    lines           JSONB NOT NULL DEFAULT '[]',
    total           BIGINT NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'open',       -- open | paid | void
    provider        VARCHAR(20) NOT NULL DEFAULT 'manual',
    provider_ref    VARCHAR(255),
    payment_url     TEXT,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_at          TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_period ON control_plane.invoices (organization_id, period_start) WHERE kind = 'period' AND status <> 'void';
CREATE INDEX IF NOT EXISTS idx_invoices_org ON control_plane.invoices (organization_id, created_at DESC);
CREATE SEQUENCE IF NOT EXISTS control_plane.invoice_number_seq;

-- processed payment-provider events (webhooks are retried: handle each once)
CREATE TABLE IF NOT EXISTS control_plane.billing_events (
    provider    VARCHAR(20) NOT NULL,
    event_id    VARCHAR(255) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, event_id)
);

-- platform-wide switches set at runtime by platform admins (e.g. billing_enabled)
CREATE TABLE IF NOT EXISTS control_plane.platform_settings (
    key        VARCHAR(100) PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
