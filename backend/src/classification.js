import { createHash } from "node:crypto";
import { suggestCategory } from "./llm.js";

const error = (message, status) =>
  Object.assign(Error(message), { status, expose: true });
const maxAttempts = 5;

// Suggestions are durable, but never write to the ledger or manual overrides.
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
        await c.query("SELECT pg_try_advisory_lock(hashtext($1)) locked", [
          `profe:classification:${id}`,
        ])
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
      // Attempts are committed before the network call so a crashed process cannot retry forever.
      if (job.attempts >= maxAttempts) {
        await c.query(
          "UPDATE classification_jobs SET status='failed',error_code='attempt_limit',updated_at=now() WHERE id=$1",
          [id],
        );
        return;
      }
      await c.query(
        "UPDATE classification_jobs SET attempts=attempts+1,next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=$1",
        [id],
      );
      let retryAfterSeconds = 0;
      try {
        const current = await input(job.transaction_id, c);
        if (current.fingerprint !== job.fingerprint) {
          await c.query(
            "UPDATE classification_jobs SET status='failed',error_code='input_changed',updated_at=now() WHERE id=$1",
            [id],
          );
          return;
        }
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
          await c.query("SELECT pg_advisory_unlock(hashtext($1))", [
            `profe:classification:${id}`,
          ]);
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
      const { rows } = await pool.query(
        "SELECT id FROM classification_jobs WHERE mode=$1 AND status='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 10",
        [config.mode],
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
    },
    async suggest(id) {
      enabled();
      const { fingerprint } = await input(id);
      const { rows } = await pool.query(
        "INSERT INTO classification_jobs(mode,transaction_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT(mode,transaction_id,fingerprint) DO UPDATE SET fingerprint=excluded.fingerprint RETURNING id",
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
