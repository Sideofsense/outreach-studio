-- Record which LLM provider/model generated each draft so the cost panel can
-- price per row. Local providers (e.g. Ollama) are free; only paid APIs accrue
-- cost. Additive only; existing rows get NULL and are attributed to the
-- currently-configured provider at read time.
ALTER TABLE drafts ADD COLUMN llm_provider TEXT;
ALTER TABLE drafts ADD COLUMN llm_model TEXT;
