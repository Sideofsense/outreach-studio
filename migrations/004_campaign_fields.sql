-- Add richer per-campaign context. Additive only; existing rows get NULLs.
ALTER TABLE companies ADD COLUMN company_link TEXT;
ALTER TABLE companies ADD COLUMN industry TEXT;
ALTER TABLE companies ADD COLUMN key_products TEXT;
ALTER TABLE companies ADD COLUMN fetched_text TEXT;
ALTER TABLE companies ADD COLUMN fetched_at DATETIME;
ALTER TABLE companies ADD COLUMN fetch_error TEXT;
