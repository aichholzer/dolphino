-- Machine classification remains independent of provider evidence and manual overrides.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_category text;
