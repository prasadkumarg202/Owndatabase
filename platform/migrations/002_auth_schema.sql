-- Auth schema for application-level authentication
-- This schema is instantiated ONCE per project database/schema
-- It handles end-user authentication, sessions, and MFA.

-- Requires pgcrypto extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE SCHEMA IF NOT EXISTS auth;

SET search_path TO auth, public;

-- ================================================================
-- APPLICATION USERS
-- ================================================================

CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               VARCHAR(255) UNIQUE,
    phone               VARCHAR(50) UNIQUE,
    email_verified      BOOLEAN NOT NULL DEFAULT FALSE,
    phone_verified      BOOLEAN NOT NULL DEFAULT FALSE,
    is_anonymous        BOOLEAN NOT NULL DEFAULT FALSE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    banned_until        TIMESTAMPTZ,
    role                VARCHAR(50) NOT NULL DEFAULT 'authenticated',
    raw_app_meta_data   JSONB NOT NULL DEFAULT '{}',    -- app-controlled metadata
    raw_user_meta_data  JSONB NOT NULL DEFAULT '{}',    -- user-controlled metadata
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_sign_in_at     TIMESTAMPTZ,
    confirmed_at        TIMESTAMPTZ,
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_auth_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_auth_users_phone ON users(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_auth_users_role ON users(role);

-- ================================================================
-- PASSWORD CREDENTIALS
-- ================================================================

CREATE TABLE IF NOT EXISTS user_passwords (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash   VARCHAR(255) NOT NULL,  -- Argon2id hash
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- IDENTITIES (OAuth / OIDC providers)
-- ================================================================

CREATE TABLE IF NOT EXISTS identities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        VARCHAR(50) NOT NULL,   -- 'email', 'google', 'github', 'phone', etc.
    provider_id     VARCHAR(255) NOT NULL,  -- External provider's user ID
    identity_data   JSONB NOT NULL DEFAULT '{}',  -- Provider profile data
    last_sign_in_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_id)
);

CREATE INDEX idx_identities_user ON identities(user_id);
CREATE INDEX idx_identities_provider ON identities(provider, provider_id);

-- ================================================================
-- SESSIONS
-- ================================================================

CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address      VARCHAR(100),
    user_agent      TEXT,
    not_after       TIMESTAMPTZ,            -- Session expiry
    refreshed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_created ON sessions(created_at DESC);

-- ================================================================
-- REFRESH TOKENS
-- ================================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              BIGSERIAL PRIMARY KEY,
    session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token           VARCHAR(255) NOT NULL UNIQUE,
    parent          VARCHAR(255),           -- Previous token (rotation chain)
    revoked         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token);
CREATE INDEX idx_refresh_tokens_session ON refresh_tokens(session_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ================================================================
-- MFA FACTORS
-- ================================================================

CREATE TYPE mfa_factor_type AS ENUM ('totp', 'sms', 'email');
CREATE TYPE mfa_factor_status AS ENUM ('unverified', 'verified');

CREATE TABLE IF NOT EXISTS mfa_factors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            mfa_factor_type NOT NULL,
    status          mfa_factor_status NOT NULL DEFAULT 'unverified',
    friendly_name   VARCHAR(255),
    secret          VARCHAR(255),           -- Encrypted TOTP secret
    phone           VARCHAR(50),            -- For SMS factor
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mfa_factors_user ON mfa_factors(user_id);

-- ================================================================
-- MFA CHALLENGES
-- ================================================================

CREATE TABLE IF NOT EXISTS mfa_challenges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    factor_id       UUID NOT NULL REFERENCES mfa_factors(id) ON DELETE CASCADE,
    verified_at     TIMESTAMPTZ,
    ip_address      VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- OTP CODES (email/phone verification, magic links)
-- ================================================================

CREATE TYPE otp_type AS ENUM ('email_verify', 'phone_verify', 'magic_link', 'password_reset', 'phone_login');

CREATE TABLE IF NOT EXISTS otp_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    email           VARCHAR(255),
    phone           VARCHAR(50),
    type            otp_type NOT NULL,
    otp_hash        VARCHAR(255) NOT NULL,  -- Hashed OTP
    token_hash      VARCHAR(255),           -- For magic links
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otp_codes_user ON otp_codes(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_otp_codes_email ON otp_codes(email) WHERE email IS NOT NULL;
CREATE INDEX idx_otp_codes_token ON otp_codes(token_hash) WHERE token_hash IS NOT NULL;

-- ================================================================
-- OAUTH STATES (PKCE + state validation)
-- ================================================================

CREATE TABLE IF NOT EXISTS oauth_states (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state           VARCHAR(255) NOT NULL UNIQUE,
    code_verifier   VARCHAR(255),           -- PKCE code_verifier
    provider        VARCHAR(50) NOT NULL,
    redirect_uri    VARCHAR(1000),
    scopes          VARCHAR(500),
    ip_address      VARCHAR(100),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth_states_state ON oauth_states(state);

-- ================================================================
-- RATE LIMITING (auth-specific)
-- ================================================================

CREATE TABLE IF NOT EXISTS auth_rate_limits (
    id              BIGSERIAL PRIMARY KEY,
    identifier      VARCHAR(255) NOT NULL,  -- IP or email
    action          VARCHAR(50) NOT NULL,   -- login, signup, otp, etc.
    attempts        INTEGER NOT NULL DEFAULT 1,
    blocked_until   TIMESTAMPTZ,
    window_start    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (identifier, action)
);

CREATE INDEX idx_rate_limits_identifier ON auth_rate_limits(identifier, action);

-- ================================================================
-- AUTH AUDIT LOGS
-- ================================================================

CREATE TABLE IF NOT EXISTS auth_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type      VARCHAR(100) NOT NULL,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    session_id      UUID REFERENCES sessions(id) ON DELETE SET NULL,
    ip_address      VARCHAR(100),
    user_agent      TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'
    -- Append-only
);

CREATE INDEX idx_auth_audit_user ON auth_audit_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_auth_audit_event ON auth_audit_log(event_type);
CREATE INDEX idx_auth_audit_timestamp ON auth_audit_log(timestamp DESC);

-- Prevent modification
CREATE OR REPLACE FUNCTION prevent_auth_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Auth audit logs are immutable.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auth_audit_no_update
    BEFORE UPDATE ON auth_audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_auth_audit_modification();

CREATE TRIGGER auth_audit_no_delete
    BEFORE DELETE ON auth_audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_auth_audit_modification();

-- ================================================================
-- HELPER FUNCTIONS
-- ================================================================

-- Returns the current authenticated user's UUID from JWT claim
-- Called as auth.uid() in RLS policies
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('request.jwt.claims', TRUE)::jsonb->>'sub', '')::UUID;
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Returns the current role from JWT claim
CREATE OR REPLACE FUNCTION auth.role()
RETURNS TEXT AS $$
BEGIN
    RETURN NULLIF(current_setting('request.jwt.claims', TRUE)::jsonb->>'role', '');
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Returns the current user's email from JWT claim
CREATE OR REPLACE FUNCTION auth.email()
RETURNS TEXT AS $$
BEGIN
    RETURN NULLIF(current_setting('request.jwt.claims', TRUE)::jsonb->>'email', '');
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ================================================================
-- UPDATED_AT TRIGGERS
-- ================================================================

CREATE OR REPLACE FUNCTION auth.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'users', 'identities', 'sessions', 'refresh_tokens',
        'mfa_factors', 'user_passwords'
    ]
    LOOP
        EXECUTE format('
            CREATE TRIGGER set_updated_at_%s
            BEFORE UPDATE ON auth.%s
            FOR EACH ROW EXECUTE FUNCTION auth.set_updated_at();
        ', t, t);
    END LOOP;
END;
$$;
