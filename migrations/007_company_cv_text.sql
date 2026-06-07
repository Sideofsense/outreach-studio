-- Per-campaign CV text for LLM personalization context.
-- Populated when a campaign CV is uploaded; supplements / overrides the setup-once CV text.
ALTER TABLE companies ADD COLUMN cv_text TEXT;
