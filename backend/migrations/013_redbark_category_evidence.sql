-- Reconciliation reads accepted immutable evidence across all imported history.
CREATE INDEX IF NOT EXISTS redbark_observations_transaction
  ON provider_observations(mode,account_id,transaction_id,fetched_at DESC,id DESC)
  WHERE provider='redbark';
