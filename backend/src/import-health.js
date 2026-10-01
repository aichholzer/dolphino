import { createHash } from "node:crypto";
import { z } from "zod";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const time = Date.parse(v);
    return (
      Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === v
    );
  }, "Invalid calendar date");
export const backfillSchema = z
  .object({
    accountId: z.string().regex(/^acct_[a-zA-Z0-9]+$/),
    from: date,
    to: date,
  })
  .strict()
  .refine(
    (v) =>
      v.from <= v.to &&
      (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 2555,
    "Use an ordered range of at most 2555 days",
  );
export const retryImportSchema = z
  .object({ jobId: z.coerce.string().regex(/^[1-9]\d{0,18}$/) })
  .strict();
function failure(code, status = 409) {
  return Object.assign(new Error(code), { status, expose: true });
}
function publicJob(row) {
  return {
    id: row.id,
    type: row.dedupe_key.split(":")[0],
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
    params: row.params,
  };
}
export function createImportHealth({
  pool,
  store,
  config,
  integration,
  now = Date.now,
}) {
  async function verified() {
    const status = await integration.status();
    if (config.mode !== "live" || !status.verified)
      throw failure(
        "Verify the live Redbark connection before requesting an import",
      );
  }
  async function status() {
    const [integrationStatus, accounts, transactions, jobs, counts] =
      await Promise.all([
        integration.status(),
        store.listAccounts(),
        pool.query(
          `SELECT account_id, count(*)::int AS "transactionCount", count(*) FILTER(WHERE status='pending')::int AS "pendingCount", count(*) FILTER(WHERE status='posted')::int AS "postedCount", min(date)::text AS "firstTransactionDate", max(date)::text AS "lastTransactionDate" FROM transactions WHERE mode=$1 AND superseded_by IS NULL GROUP BY account_id`,
          [config.mode],
        ),
        pool.query("SELECT * FROM redbark_jobs ORDER BY id DESC LIMIT 30"),
        pool.query(
          "SELECT count(*) FILTER(WHERE status='queued')::int AS queued, count(*) FILTER(WHERE status='queued' AND last_error IS NOT NULL)::int AS retrying, count(*) FILTER(WHERE status='completed')::int AS completed FROM redbark_jobs",
        ),
      ]);
    const simplefinAccounts = new Set(
      (
        await pool.query(
          "SELECT local_id FROM simplefin_accounts WHERE local_id IS NOT NULL",
        )
      ).rows.map((r) => r.local_id),
    );
    return {
      integration: integrationStatus,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        currency: a.currency,
        importSource: simplefinAccounts.has(a.id) ? "simplefin" : "redbark",
        fetchedAt: a.fetchedAt,
        coverage: a.coverage,
        transactionCount: 0,
        pendingCount: 0,
        postedCount: 0,
        firstTransactionDate: null,
        lastTransactionDate: null,
        ...transactions.rows.find((t) => t.account_id === a.id),
      })),
      jobs: jobs.rows.map(publicJob),
      counts: counts.rows[0],
    };
  }
  async function backfill(input) {
    const params = backfillSchema.parse(input);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone || "Australia/Brisbane",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now()));
    if (params.to > today)
      throw failure("Backfill cannot include future dates", 400);
    await verified();
    if (
      (
        await pool.query("SELECT 1 FROM simplefin_accounts WHERE local_id=$1", [
          params.accountId,
        ])
      ).rowCount
    )
      throw failure("Use SimpleFIN account backfill for this account");
    if (!(await store.listAccounts()).some((a) => a.id === params.accountId))
      throw failure("Account is not imported; wait for discovery first", 404);
    const key =
      "backfill:" +
      createHash("sha256").update(JSON.stringify(params)).digest("hex");
    // One durable identity per account/date range; repeated clicks/restarts never multiply imports.
    const job = await integration.queueBackfill(params, key);
    return { job: publicJob(job) };
  }
  async function retry(input) {
    const { jobId } = retryImportSchema.parse(input);
    await verified();
    // Never bypass provider Retry-After or existing per-job backoff. This reuses the same receipt/job.
    const result = await pool.query(
      "UPDATE redbark_jobs SET available_at=GREATEST(available_at,now(),COALESCE((SELECT next_attempt FROM redbark_state WHERE id=1),now())) WHERE id=$1 AND status='queued' AND last_error IS NOT NULL RETURNING *",
      [jobId],
    );
    if (result.rowCount)
      return {
        job: publicJob(result.rows[0]),
        message: "Retry scheduled; provider backoff remains in effect",
      };
    const existing = await pool.query(
      "SELECT * FROM redbark_jobs WHERE id=$1",
      [jobId],
    );
    if (!existing.rowCount) throw failure("Import job not found", 404);
    return {
      job: publicJob(existing.rows[0]),
      message: "This job is already queued or completed",
    };
  }
  return { status, backfill, retry };
}
