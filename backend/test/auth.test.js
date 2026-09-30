import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, createAuth } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
test("password hashes use random salts and reject wrong password", () => {
  const a = hashPassword("a long fictional password");
  assert.notEqual(a, hashPassword("a long fictional password"));
  assert(verifyPassword("a long fictional password", a));
  assert(!verifyPassword("wrong", a));
});
test("live mode fails closed without secrets or HTTPS", () => {
  assert.throws(() =>
    readConfig({
      PROFE_MODE: "live",
      DATABASE_URL: "postgres://localhost/test",
    }),
  );
  assert.throws(() => readConfig({ PROFE_MODE: "demo" }));
});
test("sessions are signed, Secure, HttpOnly and login attempts throttled", () => {
  const auth = createAuth({
    mode: "live",
    passwordHash: hashPassword("fictional password"),
    sessionSecret: "x".repeat(32),
  });
  const req = { socket: { remoteAddress: "test" }, headers: {} };
  const success = auth.login(req, "fictional password");
  assert.match(success.cookie, /Secure/);
  assert.match(success.cookie, /HttpOnly/);
  req.headers.cookie = success.cookie;
  assert(auth.authenticated(req));
  req.headers.cookie = success.cookie.replace(
    "profe_session=",
    "profe_session=1",
  );
  assert(!auth.authenticated(req));
  for (let n = 0; n < 5; n++)
    assert.equal(auth.login(req, "wrong").status, 401);
  assert.equal(auth.login(req, "wrong").status, 429);
});
test("REST enforces live authentication, origin and validation without returning internal errors", async (t) => {
  const config = {
    host: "127.0.0.1",
    port: 0,
    mode: "live",
    origin: "https://profe.test",
    currency: "AUD",
    timezone: "Australia/Brisbane",
    passwordHash: hashPassword("fictional password"),
    sessionSecret: "s".repeat(32),
  };
  const store = {
    pool: { query: async () => {} },
    listAccounts: async () => {
      throw Error("secret db password");
    },
  };
  const app = createApp({ config, store, integration: {} });
  const server = await new Promise((resolve) => {
    const s = app.start(() => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + "/api/accounts")).status, 401);
  assert.equal(
    (await fetch(url + "/api/login", { method: "POST", body: "{}" })).status,
    403,
  );
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { Origin: config.origin },
    body: JSON.stringify({ password: "fictional password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const failure = await fetch(url + "/api/accounts", {
    headers: { Cookie: cookie },
  });
  assert.equal(failure.status, 500);
  assert(!JSON.stringify(await failure.json()).includes("password"));
  const invalid = await fetch(url + "/api/transactions/x", {
    method: "PATCH",
    headers: { Origin: config.origin, Cookie: cookie },
    body: JSON.stringify({
      category: "",
      splits: [{ category: "X", amountMinor: 1.5 }],
    }),
  });
  assert.equal(invalid.status, 400);
});
