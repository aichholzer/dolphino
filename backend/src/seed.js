import pg from "pg";
import { readConfig } from "./config.js";
import { Store } from "./store.js";
const config = readConfig();
if (config.mode !== "demo")
  throw Error("Demo fixtures cannot be loaded in live mode");
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  const store = new Store(pool, { mode: "demo", timezone: config.timezone });
  await store.migrate();
  await store.seedDemo();
  console.log("Fictional demo fixtures ready");
} finally {
  await pool.end();
}
