import pg from "pg";
import { readFile } from "node:fs/promises";
export async function createPool(env = process.env) {
  const connectionString = env.DATABASE_URL_FILE
    ? (await readFile(env.DATABASE_URL_FILE, "utf8")).trim()
    : env.DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "DATABASE_URL or DATABASE_URL_FILE is required; dolphino never falls back to another database",
    );
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}
