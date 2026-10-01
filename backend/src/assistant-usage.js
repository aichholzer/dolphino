import { readFile } from 'node:fs/promises';
// Metadata-only durable quota. Never stores prompts, reports, financial data or provider secrets.
export function createAssistantUsage({ pool, now = Date.now }) {
  return {
    async init() {
      await pool.query(await readFile(new URL('../migrations/011_assistant_usage.sql', import.meta.url), 'utf8'));
    },
    async reserveRequest({ userId, limit }) {
      if (typeof userId !== 'string' || !userId || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw Object.assign(Error('Invalid assistant quota'), { status: 400 });
      }
      const day = new Date(now()).toISOString().slice(0, 10);
      const result = await pool.query(
        'INSERT INTO assistant_usage(user_id,usage_day,requests) VALUES($1,$2,1) ON CONFLICT(user_id,usage_day) DO UPDATE SET requests=assistant_usage.requests+1 WHERE assistant_usage.requests<$3 RETURNING requests',
        [userId, day, limit]
      );
      if (!result.rowCount) {
        throw Object.assign(Error('Daily assistant request limit reached (resets at UTC midnight)'), { status: 429 });
      }
      return { requests: result.rows[0].requests, day };
    }
  };
}
