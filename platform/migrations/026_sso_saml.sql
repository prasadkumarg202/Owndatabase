-- Single sign-on with SAML 2.0 (docs/sso.md)

CREATE TABLE IF NOT EXISTS auth.sso_providers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL,
    entity_id           TEXT NOT NULL,                 -- the IdP's entityID
    sso_url             TEXT NOT NULL,                 -- IdP SingleSignOnService (HTTP-Redirect)
    certificates        TEXT[] NOT NULL,               -- IdP signing certificates (PEM)
    metadata_xml        TEXT NOT NULL,
    metadata_url        TEXT,
    attribute_mapping   JSONB NOT NULL DEFAULT '{}',
    name_id_format      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, entity_id)
);

-- email domains an IdP is authoritative for (signInWithSSO({ domain }), and which emails it may assert)
CREATE TABLE IF NOT EXISTS auth.sso_domains (
    provider_id         UUID NOT NULL REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
    project_id          UUID NOT NULL,
    domain              TEXT NOT NULL CHECK (domain = lower(domain)),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider_id, domain),
    UNIQUE (project_id, domain)
);

-- one row per AuthnRequest we sent: RelayState, the request id the response must answer, where to go after
CREATE TABLE IF NOT EXISTS auth.saml_relay_states (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id              UUID NOT NULL,
    provider_id             UUID NOT NULL REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
    request_id              TEXT,
    redirect_to             TEXT NOT NULL,
    code_challenge          TEXT,
    code_challenge_method   TEXT,
    expires_at              TIMESTAMPTZ NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saml_relay_states_expires ON auth.saml_relay_states(expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.sso_providers, auth.sso_domains, auth.saml_relay_states TO odb_auth;
