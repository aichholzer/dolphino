import { createHash } from "node:crypto";
import { suggestCategory } from "./llm.js";

const error = (message, status) =>
  Object.assign(Error(message), { status, expose: true });
const maxAttempts = 5;

// Provider work is durable and globally serialized; automatic application is opt-in.
export function createClassificationIntegration({
  pool,
  store,
  config,
  fetchImpl = fetch,
}) {
  let timer;
  let ticking = false;
  function enabled() {
    if (!config.llmApiKey || !config.llmBaseUrl || !config.llmModel)
      throw error("LLM is disabled until a provider is configured", 409);
    let url;
    try {
      url = new URL(config.llmBaseUrl);
    } catch {
      throw error("Invalid LLM endpoint", 400);
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw error(
        "LLM endpoint must use HTTPS without embedded credentials",
        400,
      );
  }
  async function input(id, client) {
    const tx = await store.getTransaction(id, client);
    if (!tx) throw error("Transaction not found", 404);
    const categories = (await store.listCategories(client)).slice().sort();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          description: tx.description,
          amountMinor: tx.amountMinor,
          date: tx.date,
          status: tx.status,
          currency: tx.currency,
          providerCategory: tx.providerCategory,
          kind: tx.kind,
          categories,
          endpoint: config.llmBaseUrl,
          model: config.llmModel,
          credentialFingerprint: createHash("sha256")
            .update(config.llmApiKey || "")
            .digest("hex"),
        }),
      )
      .digest("hex");
    return { tx, categories, fingerprint };
  }
  async function processJob(id) {
    const c = await pool.connect();
    let locked = false;
    try {
      locked = (
        await c.query(
          "SELECT pg_try_advisory_lock(hashtext(current_schema()),hashtext($1)) locked",
          [`profe:classification:worker:${config.mode}`],
        )
      ).rows[0].locked;
      if (!locked) return;
      const job = (
        await c.query(
          "SELECT * FROM classification_jobs WHERE id=$1 AND mode=$2",
          [id, config.mode],
        )
      ).rows[0];
      if (
        !job ||
        job.status !== "pending" ||
        new Date(job.next_attempt_at) > new Date()
      )
        return;
      enabled();
      if (job.origin === "automatic" && config.llmAutoClassify === false)
        return;
      const current = await input(job.transaction_id, c);
      if (
        current.fingerprint !== job.fingerprint ||
        (job.origin === "automatic" &&
          !(await store.isAutomaticClassificationEligible(current.tx, c)))
      ) {
        await c.query(
          "UPDATE classification_jobs SET status='failed',error_code='input_changed',updated_at=now() WHERE id=$1",
          [id],
        );
        return;
      }
      if (
        job.origin === "automatic" &&
        !(await store.markAutomaticClassificationReview(
          job.transaction_id,
          current.tx,
          c,
        ))
      ) {
        await c.query(
          "UPDATE classification_jobs SET status='failed',error_code='input_changed',updated_at=now() WHERE id=$1",
          [id],
        );
        return;
      }
      // Attempts are committed before the network call so a crashed process cannot retry forever.
      if (job.attempts >= maxAttempts) {
        await c.query(
          "UPDATE classification_jobs SET status='failed',error_code='attempt_limit',updated_at=now() WHERE id=$1",
          [id],
        );
        return;
      }
      // Reserve a daily call before network I/O. A crash consumes the reservation.
      // The global session lock serializes workers across application instances.
      const reserved = await c.query(
        `INSERT INTO classification_usage(mode,day,requests)
        VALUES($1,(now() AT TIME ZONE 'UTC')::date,1)
        ON CONFLICT(mode,day) DO UPDATE SET requests=classification_usage.requests+1
        WHERE classification_usage.requests < $2 RETURNING requests`,
        [config.mode, config.llmDailyRequestLimit ?? 20],
      );
      if (!reserved.rowCount) return;
      await c.query(
        "UPDATE classification_jobs SET attempts=attempts+1,next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=$1",
        [id],
      );
      let retryAfterSeconds = 0;
      try {
        const result = await suggestCategory(
          current.tx,
          current.categories,
          config,
          async (...args) => {
            const response = await fetchImpl(...args);
            const header = response.headers?.get("retry-after");
            if (header && !response.ok) {
              const seconds = /^\d+$/.test(header)
                ? Number(header)
                : Math.ceil((Date.parse(header) - Date.now()) / 1000);
              if (Number.isFinite(seconds) && seconds > 0)
                retryAfterSeconds = Math.min(seconds, 604800);
            }
            return response;
          },
        );
        if (
          job.origin === "automatic" &&
          config.llmAutoApply &&
          result.category !== "Uncategorized"
        ) {
          const { applied } = await store.acceptAutomaticClassification(
            job.transaction_id,
            result.category,
            current.tx,
            c,
          );
          result.requiresReview = !applied;
        }
        await c.query(
          "UPDATE classification_jobs SET status='succeeded',result=$2,error_code=NULL,updated_at=now() WHERE id=$1",
          [id, result],
        );
      } catch {
        const attempts = job.attempts + 1;
        await c.query(
          "UPDATE classification_jobs SET status=$2,error_code='provider_unavailable_or_invalid',next_attempt_at=now()+($3 * interval '1 second'),updated_at=now() WHERE id=$1",
          [
            id,
            attempts >= maxAttempts ? "failed" : "pending",
            Math.max(
              retryAfterSeconds,
              Math.min(3600, 60 * 2 ** (attempts - 1)),
            ),
          ],
        );
      }
    } finally {
      try {
        if (locked)
          await c.query(
            "SELECT pg_advisory_unlock(hashtext(current_schema()),hashtext($1))",
            [`profe:classification:worker:${config.mode}`],
          );
      } finally {
        c.release();
      }
    }
  }
  async function tick() {
    if (ticking) return;
    try {
      enabled();
    } catch {
      return;
    }
    ticking = true;
    try {
      if (config.llmAutoClassify !== false) {
        const c = await pool.connect();
        try {
          const candidates = await store.automaticClassificationCandidates(c);
          let queued = 0;
          for (const tx of candidates) {
            const { fingerprint } = await input(tx.id, c);
            const inserted = await c.query(
              "INSERT INTO classification_jobs(mode,transaction_id,fingerprint,origin) VALUES($1,$2,$3,'automatic') ON CONFLICT(mode,transaction_id,fingerprint) DO NOTHING RETURNING id",
              [config.mode, tx.id, fingerprint],
            );
            queued += inserted.rowCount;
            if (queued >= (config.llmBatchSize ?? 5)) break;
          }
        } finally {
          c.release();
        }
      }
      const { rows } = await pool.query(
        "SELECT id FROM classification_jobs WHERE mode=$1 AND status='pending' AND next_attempt_at<=now() AND (origin='manual' OR $3) ORDER BY next_attempt_at,id LIMIT $2",
        [
          config.mode,
          config.llmBatchSize ?? 5,
          config.llmAutoClassify !== false,
        ],
      );
      for (const row of rows) await processJob(row.id);
    } finally {
      ticking = false;
    }
  }
  return {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS classification_jobs (
        id bigserial PRIMARY KEY, mode text NOT NULL, transaction_id text NOT NULL,
        fingerprint text NOT NULL, status text NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','succeeded','failed')),
        attempts integer NOT NULL DEFAULT 0, result jsonb, error_code text,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(mode,transaction_id,fingerprint)
      )`);
      await pool.query(
        "ALTER TABLE classification_jobs ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual'",
      );
      await pool.query(`CREATE TABLE IF NOT EXISTS classification_usage (
        mode text NOT NULL, day date NOT NULL, requests integer NOT NULL,
        PRIMARY KEY(mode,day)
      )`);
    },
    async suggest(id) {
      enabled();
      const { fingerprint } = await input(id);
      const { rows } = await pool.query(
        "INSERT INTO classification_jobs(mode,transaction_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT(mode,transaction_id,fingerprint) DO UPDATE SET origin=CASE WHEN classification_jobs.status <> 'succeeded' THEN 'manual' ELSE classification_jobs.origin END, status=CASE WHEN classification_jobs.status='failed' THEN 'pending' ELSE classification_jobs.status END, attempts=CASE WHEN classification_jobs.status='failed' THEN 0 ELSE classification_jobs.attempts END,next_attempt_at=CASE WHEN classification_jobs.status='failed' THEN now() ELSE classification_jobs.next_attempt_at END RETURNING id",
        [config.mode, id, fingerprint],
      );
      await processJob(rows[0].id);
      const job = (
        await pool.query(
          "SELECT status,result FROM classification_jobs WHERE id=$1",
          [rows[0].id],
        )
      ).rows[0];
      if (job.status === "succeeded") return job.result;
      throw error(
        job.status === "failed"
          ? "Suggestion failed after bounded retries; use manual classification"
          : "Suggestion queued for retry; try again shortly",
        503,
      );
    },
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick().catch(() => {});
      }, 30000);
      timer.unref?.();
      void tick().catch(() => {});
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
