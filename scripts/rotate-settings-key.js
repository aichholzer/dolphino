// Offline only: stop all Profe processes before running. Never prints secret material.
import { readFileSync } from "node:fs";
import { createPool } from "../backend/src/db.js";
import { createSettingsStore } from "../backend/src/settings.js";
const oldFile = process.env.APP_SECRET_FILE;
const newFile = process.env.NEW_APP_SECRET_FILE;
if (!oldFile || !newFile)
  throw Error(
    "Provide APP_SECRET_FILE and NEW_APP_SECRET_FILE; stop the app and back up database and old key first",
  );
const pool = await createPool();
try {
  const settings = createSettingsStore({
    pool,
    appSecret: readFileSync(oldFile, "utf8").trim(),
  });
  const count = await settings.rotateSecrets(
    readFileSync(newFile, "utf8").trim(),
  );
  console.log(
    `Rotated ${count} encrypted credentials. Install the new APP_SECRET before restarting Profe. Retain the old key with pre-rotation backups.`,
  );
} finally {
  await pool.end();
}
