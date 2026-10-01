import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import pg from "pg";
import {
  createHouseholdAuth,
  hashHouseholdPassword,
  verifyHouseholdPassword,
  householdSessionToken,
} from "../src/household-auth.js";
const password = "fictional-only-password-123";
const req = (cookie = "", ip = "127.0.0.1") => ({
  headers: { cookie },
  socket: { remoteAddress: ip },
});

test("household scrypt has independent salts, verifies without blocking timers, rejects malformed hashes and oversized passwords", async () => {
  let timerRan = false;
  setTimeout(() => {
    timerRan = true;
  }, 0);
  const first = await hashHouseholdPassword(password);
  assert(timerRan);
  const second = await hashHouseholdPassword(password);
  assert.notEqual(first, second);
  assert(await verifyHouseholdPassword(password, first));
  assert(!(await verifyHouseholdPassword("incorrect", first)));
  assert(!(await verifyHouseholdPassword(password, "scrypt:legacy")));
  await assert.rejects(hashHouseholdPassword("short"), /12 to 128/);
  assert.equal(householdSessionToken(req("dolphino_session=bad")), null);
});
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test(
  "first-admin proof and race, opaque revocable sessions, password reset revocation, persistent rate limits and demo separation",
  { skip: !connectionString, timeout: 20000 },
  async () => {
    const admin = new pg.Pool({ connectionString });
    const schema = `household_auth_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    const config = {
      mode: "live",
      bootstrapToken: randomBytes(32).toString("base64"),
    };
    const auth = createHouseholdAuth({ pool, config });
    try {
      await auth.init();
      assert.equal((await auth.setupStatus()).needsSetup, true);
      const input = {
        email: "ADMIN@Example.com",
        name: "Fictional Admin",
        password,
        bootstrapToken: config.bootstrapToken,
      };
      await assert.rejects(
        auth.bootstrap(req(), { ...input, bootstrapToken: "wrong" }),
        /proof/,
      );
      // Existing financial tables do not grant access or bypass operator proof.
      await pool.query(
        "CREATE TABLE fictional_financial_data(amount integer); INSERT INTO fictional_financial_data VALUES(123)",
      );
      const race = await Promise.allSettled([
        auth.bootstrap(req(), input),
        auth.bootstrap(req(), { ...input, email: "second@example.com" }),
      ]);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        race.filter((r) => r.status === "rejected" && r.reason.status === 409)
          .length,
        1,
      );
      const created = race.find((r) => r.status === "fulfilled").value;
      assert.match(created.cookie, /HttpOnly/);
      assert.match(created.cookie, /SameSite=Strict/);
      assert.match(created.cookie, /Secure/);
      const logged = req(created.cookie);
      const user = await auth.session(logged);
      assert.equal(user.role, "admin");
      assert(!JSON.stringify(user).includes("password"));
      const token = householdSessionToken(logged);
      const rows = (await pool.query("SELECT * FROM household_sessions")).rows;
      assert(!JSON.stringify(rows).includes(token));
      assert.equal(
        rows[0].token_hash,
        createHash("sha256").update(token).digest("hex"),
      );
      assert.equal(
        await auth.session(
          req(`dolphino_session=${token}; dolphino_session=${token}`),
        ),
        null,
      );
      assert.equal(
        (await createHouseholdAuth({ pool, config }).session(logged)).id,
        user.id,
      );
      await assert.rejects(
        auth.login(req(), { email: user.email, password: "wrong" }),
        /Email or password is incorrect/,
      );
      const again = await auth.login(req(), { email: user.email, password });
      await pool.query(
        "CREATE TABLE household_invitations(user_id uuid,purpose text,used_at timestamptz,revoked_at timestamptz)",
      );
      await pool.query(
        "INSERT INTO household_invitations(user_id,purpose) VALUES($1,'reset')",
        [user.id],
      );
      await auth.changePassword(logged, {
        currentPassword: password,
        newPassword: "fictional-new-password-456",
      });
      assert.equal(await auth.session(logged), null);
      assert.equal(await auth.session(req(again.cookie)), null);
      assert(
        (await pool.query("SELECT revoked_at FROM household_invitations"))
          .rows[0].revoked_at,
      );
      const latest = await auth.login(req(), {
        email: user.email,
        password: "fictional-new-password-456",
      });
      await auth.logout(req(latest.cookie));
      assert.equal(await auth.session(req(latest.cookie)), null);
      await pool.query(
        "INSERT INTO household_auth_limits(key_hash,attempts,expires_at) VALUES($1,10,now()+interval '15 minutes')",
        [createHash("sha256").update("login:198.51.100.7").digest("hex")],
      );
      await assert.rejects(
        createHouseholdAuth({ pool, config }).login(req("", "198.51.100.7"), {
          email: user.email,
          password,
        }),
        (e) => e.status === 429,
      );
      const audit = JSON.stringify(
        (await pool.query("SELECT * FROM household_security_audit")).rows,
      );
      assert(!audit.includes(password));
      assert(!audit.includes(config.bootstrapToken));
      assert(!audit.includes(user.email));
      await pool.query(
        "DELETE FROM household_sessions; DELETE FROM household_users",
      );
      assert.equal((await auth.setupStatus()).needsSetup, false);
      await assert.rejects(auth.bootstrap(req(), input), /already complete/);
      const demo = createHouseholdAuth({ pool, config: { mode: "demo" } });
      await demo.init();
      assert.equal((await demo.session(req())).name, "Alex (fictional demo)");
      assert.equal((await demo.setupStatus()).needsSetup, false);
      assert.equal(
        (await pool.query("SELECT * FROM household_users")).rowCount,
        0,
      );
      await assert.rejects(demo.bootstrap(req(), input), /fictional demo/);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
