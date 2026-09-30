-- SMS as a second factor (docs/mfa.md): challenges carry a hashed one-time code for phone factors
ALTER TABLE auth.mfa_challenges ADD COLUMN IF NOT EXISTS otp_hash TEXT;
ALTER TABLE auth.mfa_challenges ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE auth.mfa_challenges ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_factor ON auth.mfa_challenges(factor_id, created_at DESC);
