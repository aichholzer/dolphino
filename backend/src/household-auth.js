import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
const derive = promisify(scrypt);
const reject = (message, status = 400) =>
  Object.assign(Error(message), { status, expose: true });
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const householdPasswordSchema = z.string().min(12).max(128);
export const householdEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email();
const signupSchema = z
  .object({
    email: householdEmailSchema,
    name: z.string().trim().min(1).max(100),
    password: householdPasswordSchema,
    bootstrapToken: z.string().max(512),
  })
  .strict();
const COST = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let activeDerivations = 0;
async function kdf(password, salt) {
  if (activeDerivations >= 2)
    throw reject("Authentication busy; retry shortly", 503);
  activeDerivations++;
  try {
    return await derive(password, salt, 64, COST);
  } finally {
    activeDerivations--;
  }
}
export async function hashHouseholdPassword(password) {
  if (!householdPasswordSchema.safeParse(password).success)
    throw reject("Password must contain 12 to 128 characters");
  const salt = randomBytes(16).toString("hex");
  const key = await kdf(password, salt);
  return `scrypt-v1:${salt}:${key.toString("hex")}`;
}
export async function verifyHouseholdPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 128) return false;
  const parsed = /^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(
    encoded || "",
  );
  if (!parsed) return false;
  return timingSafeEqual(
    await kdf(password, parsed[1]),
    Buffer.from(parsed[2], "hex"),
  );
}
const DUMMY_HASH = `scrypt-v1:${"0".repeat(32)}:${"0".repeat(128)}`;
export async function appendHouseholdAudit(
  client,
  { actorUserId = null, action, targetUserId = null },
) {
  if (typeof action !== "string" || !/^[a-z][a-z0-9_.-]{0,79}$/.test(action))
    throw reject("Invalid audit action");
  await client.query(
    "INSERT INTO household_security_audit(actor_user_id,action,target_user_id) VALUES($1,$2,$3)",
    [actorUserId, action, targetUserId],
  );
}
export function validBootstrapToken(value) {
  return (
    typeof value === "string" &&
    value.length >= 43 &&
    value.length <= 512 &&
    new Set(value).size >= 12 &&
    /^[A-Za-z0-9_+/=-]+$/.test(value) &&
    !/example|changeme|replace/i.test(value)
  );
}
const publicUser = (row) =>
  row ? { id: row.id, email: row.email, name: row.name, role: row.role } : null;
// Prefer the new cookie if both exist; an invalid new cookie never falls back to an old token.
export function householdSessionToken(req) {
  const parts = (req.headers?.cookie || "").split(";").map((s) => s.trim());
  for (const name of ["dolphino_session", "profe_session"]) {
    const matches = parts.filter((s) => s.startsWith(`${name}=`));
    if (!matches.length) continue;
    if (matches.length !== 1) return null;
    const token = matches[0].slice(name.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }
  return null;
}
export function createHouseholdAuth({ pool, config, now = Date.now }) {
  const cookie = (token, maxAge = 43200) =>
    `dolphino_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.mode === "live" ? "; Secure" : ""}`;
  // Expire both names so a legacy session cannot reappear after logging out.
  const clearedCookies = () => [
    cookie("", 0),
    cookie("", 0).replace("dolphino_session=", "profe_session="),
  ];
  async function atomic(fn) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async function rate(req, action) {
    // Proxy-supplied address headers are untrusted. A reverse proxy shares this limit.
    const key = digest(`${action}:${req.socket?.remoteAddress || "unknown"}`);
    await pool.query(
      "DELETE FROM household_auth_limits WHERE expires_at<now()",
    );
    const { rows } = await pool.query(
      "INSERT INTO household_auth_limits(key_hash,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key_hash) DO UPDATE SET attempts=household_auth_limits.attempts+1 RETURNING attempts",
      [key],
    );
    if (rows[0].attempts > 10)
      throw reject(
        "Too many authentication attempts; retry in 15 minutes",
        429,
      );
  }
  async function session(req) {
    if (config.mode === "demo")
      return publicUser(
        (
          await pool.query(
            "SELECT * FROM household_demo_users WHERE role='admin' ORDER BY email LIMIT 1",
          )
        ).rows[0],
      );
    const token = householdSessionToken(req);
    if (!token) return null;
    const { rows } = await pool.query(
      "SELECT u.id,u.email,u.name,u.role FROM household_sessions s JOIN household_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled",
      [digest(token)],
    );
    return publicUser(rows[0]);
  }
  async function issue(c, user) {
    const token = randomBytes(32).toString("base64url");
    await c.query("DELETE FROM household_sessions WHERE expires_at<=now()");
    await c.query(
      "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [digest(token), user.id, new Date(now() + 43200000)],
    );
    return { user: publicUser(user), cookie: cookie(token) };
  }
  return {
    async init() {
      await pool.query(
        await readFile(
          new URL("../migrations/008_users.sql", import.meta.url),
          "utf8",
        ),
      );
      if (config.mode === "demo")
        await pool.query(
          "INSERT INTO household_demo_users(email,name,role) VALUES('alex.demo@example.invalid','Alex (fictional demo)','admin'),('sam.demo@example.invalid','Sam (fictional demo)','member') ON CONFLICT(email) DO NOTHING",
        );
    },
    session,
    rate,
    async setupStatus() {
      const state = (
        await pool.query(
          "SELECT bootstrap_closed FROM household_auth_state WHERE singleton=true",
        )
      ).rows[0];
      const setupRequired =
        config.mode !== "demo" &&
        !state?.bootstrap_closed &&
        !(await pool.query("SELECT 1 FROM household_users LIMIT 1")).rowCount;
      return {
        setupRequired,
        needsSetup: setupRequired,
        bootstrapConfigured: validBootstrapToken(config.bootstrapToken),
      };
    },
    async bootstrap(req, input) {
      if (config.mode === "demo")
        throw reject(
          "Administrator setup is unavailable in fictional demo mode",
          409,
        );
      await rate(req, "bootstrap");
      const parsed = signupSchema.safeParse(input);
      if (!parsed.success) throw reject("Invalid administrator setup fields");
      const value = parsed.data;
      if (
        !validBootstrapToken(config.bootstrapToken) ||
        !timingSafeEqual(
          Buffer.from(digest(value.bootstrapToken), "hex"),
          Buffer.from(digest(config.bootstrapToken), "hex"),
        )
      )
        throw reject("Administrator setup proof is invalid", 403);
      // Deployment-local proof is mandatory even with legacy financial data or shared-password configuration.
      const passwordHash = await hashHouseholdPassword(value.password);
      return atomic(async (c) => {
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtext(current_schema()),17092384)",
        );
        const closed = (
          await c.query(
            "SELECT bootstrap_closed FROM household_auth_state WHERE singleton=true FOR UPDATE",
          )
        ).rows[0];
        if (
          closed?.bootstrap_closed ||
          (await c.query("SELECT 1 FROM household_users LIMIT 1")).rowCount
        )
          throw reject("Administrator setup is already complete", 409);
        const user = (
          await c.query(
            "INSERT INTO household_users(email,name,role,password_hash) VALUES($1,$2,'admin',$3) RETURNING *",
            [value.email, value.name, passwordHash],
          )
        ).rows[0];
        await c.query(
          "UPDATE household_auth_state SET bootstrap_closed=true WHERE singleton=true",
        );
        await appendHouseholdAudit(c, {
          actorUserId: user.id,
          action: "administrator.bootstrap",
          targetUserId: user.id,
        });
        return issue(c, user);
      });
    },
    async login(req, { email, password } = {}) {
      if (config.mode === "demo")
        throw reject("Sign-in is unavailable in fictional demo mode", 409);
      await rate(req, "login");
      const parsed = householdEmailSchema.safeParse(email);
      const user = parsed.success
        ? (
            await pool.query("SELECT * FROM household_users WHERE email=$1", [
              parsed.data,
            ])
          ).rows[0]
        : null;
      const valid = await verifyHouseholdPassword(
        password,
        user?.password_hash || DUMMY_HASH,
      );
      if (!valid || !user || user.disabled) {
        await appendHouseholdAudit(pool, { action: "authentication.failed" });
        throw reject("Email or password is incorrect", 401);
      }
      return atomic(async (c) => {
        const current = (
          await c.query(
            "SELECT * FROM household_users WHERE id=$1 FOR UPDATE",
            [user.id],
          )
        ).rows[0];
        if (
          !current ||
          current.disabled ||
          current.password_hash !== user.password_hash
        )
          throw reject("Email or password is incorrect", 401);
        await appendHouseholdAudit(c, {
          actorUserId: current.id,
          action: "authentication.login",
          targetUserId: current.id,
        });
        return issue(c, current);
      });
    },
    async logout(req) {
      const token = householdSessionToken(req);
      if (token)
        await atomic(async (c) => {
          const removed = await c.query(
            "DELETE FROM household_sessions WHERE token_hash=$1 RETURNING user_id",
            [digest(token)],
          );
          if (removed.rowCount)
            await appendHouseholdAudit(c, {
              actorUserId: removed.rows[0].user_id,
              action: "authentication.logout",
            });
        });
      return { cookie: clearedCookies() };
    },
    async changePassword(req, { currentPassword, newPassword } = {}) {
      if (config.mode === "demo")
        throw reject(
          "Password changes are unavailable in fictional demo mode",
          409,
        );
      await rate(req, "password-change");
      const user = await session(req);
      if (!user) throw reject("Sign in required", 401);
      if (!householdPasswordSchema.safeParse(newPassword).success)
        throw reject("Password must contain 12 to 128 characters");
      return atomic(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(17092390)");
        const current = (
          await c.query(
            "SELECT * FROM household_users WHERE id=$1 FOR UPDATE",
            [user.id],
          )
        ).rows[0];
        if (
          !current ||
          current.disabled ||
          !(await verifyHouseholdPassword(
            currentPassword,
            current.password_hash,
          ))
        )
          throw reject("Current password is incorrect", 401);
        const token = householdSessionToken(req);
        if (
          !(
            await c.query(
              "SELECT 1 FROM household_sessions WHERE token_hash=$1 AND expires_at>now()",
              [digest(token)],
            )
          ).rowCount
        )
          throw reject("Sign in required", 401);
        const hash = await hashHouseholdPassword(newPassword);
        await c.query(
          "UPDATE household_users SET password_hash=$2,updated_at=now() WHERE id=$1",
          [user.id, hash],
        );
        await c.query("DELETE FROM household_sessions WHERE user_id=$1", [
          user.id,
        ]);
        if (
          (
            await c.query(
              "SELECT to_regclass('household_invitations') table_name",
            )
          ).rows[0].table_name
        )
          await c.query(
            "UPDATE household_invitations SET revoked_at=now() WHERE user_id=$1 AND purpose='reset' AND used_at IS NULL AND revoked_at IS NULL",
            [user.id],
          );
        await appendHouseholdAudit(c, {
          actorUserId: user.id,
          action: "password.changed",
          targetUserId: user.id,
        });
        return { cookie: clearedCookies() };
      });
    },
    logoutCookie: clearedCookies(),
  };
}
