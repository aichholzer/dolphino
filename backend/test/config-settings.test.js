import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readConfig } from "../src/config.js";

test("deployment configuration never reads retired provider or Redbark environment values or files", () => {
  const env = new Proxy(
    {
      DATABASE_URL: "postgresql://synthetic.invalid/test",
      LLM_API_KEY_FILE: "/nonexistent-do-not-read/llm",
      REDBARK_API_KEY_FILE: "/nonexistent-do-not-read/redbark",
      LLM_DAILY_REQUEST_LIMIT: "invalid",
      LLM_AUTO_CLASSIFY: "invalid",
      LLM_BASE_URL: "http://127.0.0.1/credential-exfiltration",
    },
    {
      get(target, property) {
        assert(
          !/^(?:LLM|REDBARK)_/.test(String(property)),
          `Retired setting read: ${property}`,
        );
        return target[property];
      },
    },
  );
  const config = readConfig(env);
  assert(!Object.keys(config).some((key) => /^(llm|redbark)/.test(key)));
});

test("deployment secrets, currency and timezone still support the documented environment inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "dolphino-config-"));
  const appSecret = randomBytes(32).toString("base64");
  const secretPath = join(dir, "app-secret");
  writeFileSync(secretPath, appSecret, { mode: 0o600 });
  try {
    const config = readConfig({
      DATABASE_URL: "postgresql://synthetic.invalid/test",
      APP_SECRET_FILE: secretPath,
      DOLPHINO_CURRENCY: "NZD",
      DOLPHINO_TIMEZONE: "Pacific/Auckland",
    });
    assert.equal(config.appSecret, appSecret);
    assert.equal(config.currency, "NZD");
    assert.equal(config.timezone, "Pacific/Auckland");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
