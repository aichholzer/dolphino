import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  hashHouseholdPassword,
  appendHouseholdAudit,
} from "./household-auth.js";
import { validateGrants, validateAndSetGrants, listGrants } from "./access.js";
import { sendSmtp } from "./notifications.js";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email()
  .refine((v) => !/[\r\n]/.test(v));
const roleSchema = z.enum(["admin", "member"]);
const visible = (r) => ({
  id: r.id,
  email: r.email,
  role: r.role,
  purpose: r.purpose,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
  revokedAt: r.revoked_at,
  deliveryState: r.delivery_state,
  lastError: r.last_error,
  grants: r.grants,
});
function origin(config) {
  const url = new URL(config.origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw fail(
      "Configure an HTTPS application origin before sending invitations",
    );
  return url.origin;
}
export function createUserManagement({
  pool,
  config,
  settings,
  sendMail = sendSmtp,
  now = Date.now,
}) {
  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(17092390)");
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
  async function admin(c, actorId) {
    const user = (
      await c.query("SELECT * FROM household_users WHERE id=$1", [actorId])
    ).rows[0];
    if (!user || user.disabled || user.role !== "admin")
      throw fail("Administrator access required", 403);
    return user;
  }
  async function prepare(
    c,
    {
      email,
      role,
      purpose,
      userId,
      actorId,
      operator = false,
      grants = { accounts: [], budgets: [] },
    },
  ) {
    grants =
      role === "admin"
        ? { accounts: [], budgets: [] }
        : await validateGrants(c, grants, { mode: config.mode || "live" });
    const base = origin(config),
      token = randomBytes(32).toString("base64url");
    await c.query(
      "UPDATE household_invitations SET revoked_at=now() WHERE email=$1 AND purpose=$2 AND used_at IS NULL AND revoked_at IS NULL",
      [email, purpose],
    );
    const row = (
      await c.query(
        "INSERT INTO household_invitations(email,role,purpose,user_id,token_hash,expires_at,delivery_state,grants) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [
          email,
          role,
          purpose,
          userId || null,
          sha(token),
          new Date(now() + (purpose === "invite" ? 7 * 86400000 : 3600000)),
          operator ? "operator" : "sending",
          JSON.stringify(grants),
        ],
      )
    ).rows[0];
    await appendHouseholdAudit(c, {
      actorUserId: actorId || null,
      action: operator
        ? "recovery_link_created"
        : purpose === "invite"
          ? "invitation_created"
          : "password_reset_requested",
      targetUserId: userId || null,
    });
    return {
      row,
      link: `${base}/${purpose === "invite" ? "activate" : "reset-password"}#token=${token}`,
    };
  }
  async function deliver(prepared) {
    const { row, link } = prepared;
    try {
      const smtp = await settings.getValue("notifications.smtp"),
        smtpUrl = await settings.getSecret("notifications.smtp.url", "smtp");
      if (!smtp?.from || !smtpUrl) throw fail("smtp_unconfigured");
      await sendMail({
        smtpUrl,
        from: smtp.from,
        to: row.email,
        subject:
          row.purpose === "invite"
            ? "Your Profe household invitation"
            : "Reset your Profe password",
        text: `${row.purpose === "invite" ? "You have been invited to Profe." : "A Profe administrator requested a password reset."}\nOpen this single-use link and choose your own password:\n${link}\nExpires: ${new Date(row.expires_at).toISOString()}\nIf unexpected, ignore this email.`,
        messageId: `<profe-user-${row.id}@profe.local>`,
      });
      await pool.query(
        "UPDATE household_invitations SET delivery_state='sent',last_error=NULL WHERE id=$1",
        [row.id],
      );
    } catch {
      await pool.query(
        "UPDATE household_invitations SET delivery_state='failed',last_error='Email delivery failed; verify SMTP and resend to issue a fresh link' WHERE id=$1",
        [row.id],
      );
    }
    return visible(
      (
        await pool.query("SELECT * FROM household_invitations WHERE id=$1", [
          row.id,
        ])
      ).rows[0],
    );
  }
  return {
    async init() {
      await pool.query(
        await readFile(
          new URL("../migrations/009_invitations.sql", import.meta.url),
          "utf8",
        ),
      );
    },
    async grantOptions({ actorId }) {
      return tx(async (c) => {
        await admin(c, actorId);
        return {
          accounts: (
            await c.query(
              "SELECT id,coalesce(local_label,name) AS name,currency FROM accounts WHERE mode=$1 ORDER BY name",
              [config.mode || "live"],
            )
          ).rows,
          budgets: (
            await c.query(
              "SELECT id,category,month,currency FROM budgets WHERE mode=$1 ORDER BY month DESC,category",
              [config.mode || "live"],
            )
          ).rows,
        };
      });
    },
    async list({ actorId }) {
      return tx(async (c) => {
        await admin(c, actorId);
        const users = (
          await c.query(
            'SELECT id,email,name,role,disabled,created_at AS "createdAt" FROM household_users ORDER BY created_at',
          )
        ).rows;
        for (const user of users)
          user.grants = await listGrants(c, user.id, {
            mode: config.mode || "live",
          });
        return {
          users,
          invitations: (
            await c.query(
              "SELECT * FROM household_invitations ORDER BY created_at DESC LIMIT 200",
            )
          ).rows.map(visible),
        };
      });
    },
    async invite({ actorId, email, role = "member", grants }) {
      email = emailSchema.parse(email);
      role = roleSchema.parse(role);
      return deliver(
        await tx(async (c) => {
          await admin(c, actorId);
          if (
            (
              await c.query("SELECT 1 FROM household_users WHERE email=$1", [
                email,
              ])
            ).rowCount
          )
            throw fail("User already exists; use password reset");
          return prepare(c, {
            email,
            role,
            purpose: "invite",
            actorId,
            grants,
          });
        }),
      );
    },
    async resend({ actorId, invitationId }) {
      return deliver(
        await tx(async (c) => {
          await admin(c, actorId);
          const r = (
            await c.query("SELECT * FROM household_invitations WHERE id=$1", [
              invitationId,
            ])
          ).rows[0];
          if (!r || r.used_at || r.revoked_at)
            throw fail("Invitation unavailable");
          return prepare(c, {
            email: r.email,
            grants: r.grants,
            role: r.role,
            purpose: r.purpose,
            userId: r.user_id,
            actorId,
          });
        }),
      );
    },
    async revoke({ actorId, invitationId }) {
      return tx(async (c) => {
        await admin(c, actorId);
        const r = await c.query(
          "UPDATE household_invitations SET revoked_at=now() WHERE id=$1 AND used_at IS NULL RETURNING user_id",
          [invitationId],
        );
        if (!r.rowCount) throw fail("Invitation unavailable");
        await appendHouseholdAudit(c, {
          actorUserId: actorId,
          action: "invitation_revoked",
          targetUserId: r.rows[0].user_id,
        });
        return { ok: true };
      });
    },
    async resetPassword({ actorId, userId }) {
      return deliver(
        await tx(async (c) => {
          await admin(c, actorId);
          const user = (
            await c.query("SELECT * FROM household_users WHERE id=$1", [userId])
          ).rows[0];
          if (!user || user.disabled) throw fail("User unavailable");
          return prepare(c, {
            email: user.email,
            role: user.role,
            purpose: "reset",
            userId,
            actorId,
          });
        }),
      );
    },
    async activate({ token, password, name }) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
        throw fail("Link is invalid or expired", 400);
      const valid = await pool.query(
        "SELECT 1 FROM household_invitations WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>$2",
        [sha(token), new Date(now())],
      );
      if (!valid.rowCount) throw fail("Link is invalid or expired", 400);
      const passwordHash = await hashHouseholdPassword(password);
      return tx(async (c) => {
        const r = (
          await c.query(
            "SELECT * FROM household_invitations WHERE token_hash=$1",
            [sha(token)],
          )
        ).rows[0];
        if (
          !r ||
          r.used_at ||
          r.revoked_at ||
          new Date(r.expires_at).getTime() <= now()
        )
          throw fail("Link is invalid or expired", 400);
        let userId = r.user_id;
        if (r.purpose === "invite") {
          const displayName = z.string().trim().min(1).max(100).parse(name);
          if (
            (
              await c.query("SELECT 1 FROM household_users WHERE email=$1", [
                r.email,
              ])
            ).rowCount
          )
            throw fail("Link is invalid or expired", 400);
          userId = (
            await c.query(
              "INSERT INTO household_users(email,name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id",
              [r.email, displayName, r.role, passwordHash],
            )
          ).rows[0].id;
        } else {
          const result = await c.query(
            "UPDATE household_users SET password_hash=$1,updated_at=now() WHERE id=$2 AND email=$3 AND disabled=false RETURNING id",
            [passwordHash, userId, r.email],
          );
          if (!result.rowCount) throw fail("Link is invalid or expired", 400);
          await c.query("DELETE FROM household_sessions WHERE user_id=$1", [
            userId,
          ]);
        }
        if (r.purpose === "invite")
          await validateAndSetGrants(c, userId, r.grants, {
            mode: config.mode || "live",
          });
        await c.query(
          "UPDATE household_invitations SET used_at=now() WHERE id=$1",
          [r.id],
        );
        await appendHouseholdAudit(c, {
          actorUserId: userId,
          action:
            r.purpose === "invite"
              ? "invitation_accepted"
              : "password_reset_completed",
          targetUserId: userId,
        });
        return { ok: true };
      });
    },
    async updateUser({ actorId, userId, role, disabled, grants }) {
      if (role !== undefined) role = roleSchema.parse(role);
      if (disabled !== undefined && typeof disabled !== "boolean")
        throw fail("Invalid disabled value", 400);
      return tx(async (c) => {
        await admin(c, actorId);
        const user = (
          await c.query("SELECT * FROM household_users WHERE id=$1", [userId])
        ).rows[0];
        if (!user) throw fail("User unavailable", 404);
        const nextRole = role ?? user.role,
          nextDisabled = disabled ?? user.disabled;
        if (actorId === userId && (nextRole !== "admin" || nextDisabled))
          throw fail(
            "You cannot demote or disable your own administrator account",
          );
        if (
          user.role === "admin" &&
          !user.disabled &&
          (nextRole !== "admin" || nextDisabled) &&
          (
            await c.query(
              "SELECT 1 FROM household_users WHERE role='admin' AND disabled=false AND id<>$1",
              [userId],
            )
          ).rowCount === 0
        )
          throw fail("The last active administrator must remain enabled");
        if (
          grants !== undefined ||
          nextRole !== user.role ||
          nextRole === "admin"
        )
          await validateAndSetGrants(
            c,
            userId,
            nextRole === "admin"
              ? { accounts: [], budgets: [] }
              : grants || { accounts: [], budgets: [] },
            { mode: config.mode || "live" },
          );
        await c.query(
          "UPDATE household_users SET role=$1,disabled=$2,updated_at=now() WHERE id=$3",
          [nextRole, nextDisabled, userId],
        );
        await c.query("DELETE FROM household_sessions WHERE user_id=$1", [
          userId,
        ]);
        await appendHouseholdAudit(c, {
          actorUserId: actorId,
          action: "user_access_updated",
          targetUserId: userId,
        });
        return { ok: true };
      });
    },
    async createRecoveryLink({ email }) {
      email = emailSchema.parse(email);
      return tx(async (c) => {
        const user = (
          await c.query(
            "SELECT * FROM household_users WHERE email=$1 AND disabled=false",
            [email],
          )
        ).rows[0];
        if (!user) throw fail("Active user not found");
        return (
          await prepare(c, {
            email,
            role: user.role,
            purpose: "reset",
            userId: user.id,
            operator: true,
          })
        ).link;
      });
    },
  };
}
