import pg from "pg";
import { readConfig } from "./config.js";
import { Store } from "./store.js";
import { createRedbarkIntegration } from "./worker.js";
import { createClassificationIntegration } from "./classification.js";
import { createApp } from "./app.js";
const config = readConfig();
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5000,
});
pool.on("error", () => console.error("Database connection unavailable"));
const store = new Store(pool, { mode: config.mode, timezone: config.timezone });
await store.migrate();
const integration = createRedbarkIntegration({ pool, store, config });
await integration.init();
const classification = createClassificationIntegration({ pool, store, config });
await classification.init();
const app = createApp({ store, integration, classification, config });
const server = app.start(() =>
  console.log(`Profe ${config.mode} listening on port ${config.port}`),
);
integration.start();
classification.start();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  integration.stop();
  classification.stop();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
