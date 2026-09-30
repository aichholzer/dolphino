import pg from "pg";
import { readConfig } from "./config.js";
import { Store } from "./store.js";
import { ensureRedbarkSchema } from "./worker.js";
const config = readConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  await new Store(pool, {
    mode: config.mode,
    timezone: config.timezone,
  }).migrate();
  await ensureRedbarkSchema(pool);
  console.log("Migrations complete");
} finally {
  await pool.end();
}
