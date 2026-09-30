-- GST tax invoices (docs/billing.md → GST). The seller's details are a platform setting ('gst');
-- each organization has billing details; invoices keep a snapshot of both and their tax breakdown.

CREATE TABLE IF NOT EXISTS control_plane.billing_profiles (
    organization_id UUID PRIMARY KEY REFERENCES control_plane.organizations(id) ON DELETE CASCADE,
    legal_name      VARCHAR(200) NOT NULL,
    gstin           VARCHAR(15),                    -- registered business customers (B2B)
    address_line1   VARCHAR(200) NOT NULL DEFAULT '',
    address_line2   VARCHAR(200) NOT NULL DEFAULT '',
    city            VARCHAR(100) NOT NULL DEFAULT '',
    postal_code     VARCHAR(20)  NOT NULL DEFAULT '',
    state_code      CHAR(2),                        -- GST state code, for customers in India
    country         CHAR(2) NOT NULL DEFAULT 'IN',
    email           VARCHAR(255),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE control_plane.invoices ADD COLUMN IF NOT EXISTS subtotal BIGINT;             -- taxable value; NULL on invoices from before GST
ALTER TABLE control_plane.invoices ADD COLUMN IF NOT EXISTS tax_total BIGINT NOT NULL DEFAULT 0;
ALTER TABLE control_plane.invoices ADD COLUMN IF NOT EXISTS tax_lines JSONB NOT NULL DEFAULT '[]';   -- [{ name: 'CGST', rate: 9, amount }]
ALTER TABLE control_plane.invoices ADD COLUMN IF NOT EXISTS tax_note TEXT;              -- e.g. export under LUT
ALTER TABLE control_plane.invoices ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(100);
ALTER TABLE control_plane.invoices ADD COLUMN IF NOT EXISTS sac_code VARCHAR(10);
ALTER TABLE control_plane.invoices ADD COLUMN IF NOT EXISTS seller JSONB;
ALTER TABLE control_plane.invoices ADD COLUMN IF NOT EXISTS buyer JSONB;
