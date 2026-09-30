import rayo from "rayo";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { z } from "zod";
import { testProviderConnection, testProviderModel } from "./llm.js";
import { createAccessStore } from "./access.js";
import { createHouseholdAuth } from "./household-auth.js";
const minor = z.string().regex(/^-?\d{1,18}$/);
const category = z.string().trim().min(1).max(100);
const kind = z.enum(["expense", "income", "transfer", "refund"]);
const grants = z
  .object({
    accounts: z
      .array(
        z
          .object({
            accountId: z.string().min(1).max(200),
            access: z.enum(["view", "edit"]),
          })
          .strict(),
      )
      .max(1000),
    budgets: z
      .array(
        z
          .object({
            budgetId: z.string().uuid(),
            access: z.enum(["view", "edit"]),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
const correction = z
  .object({
    category: category.optional(),
    kind: kind.optional(),
    note: z.string().max(1000).optional(),
    splits: z
      .array(z.object({ category, amountMinor: minor }))
      .max(50)
      .optional(),
  })
  .strict();
const budget = z
  .object({
    category,
    capMinor: minor,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("AUD"),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    allocationMinor: minor.optional(),
    rolloverEnabled: z.boolean().optional(),
    rollover: z.boolean().optional(),
  })
  .strict();
export async function body(req, raw = false) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1048576)
      throw Object.assign(Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks);
  if (raw) return value;
  try {
    return JSON.parse(value.toString() || "{}");
  } catch {
    throw Object.assign(Error("Invalid JSON"), { status: 400 });
  }
}
function send(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
export function createApp({
  store,
  integration,
  classification,
  config,
  settings,
  registration,
  providerDependencies,
  notifications,
  telegram,
  importHealth,
  auth = createHouseholdAuth({ pool: store.pool, config }),
  users,
}) {
  const app = rayo({
    host: config.host,
    port: config.port,
    notFound: (req, res) => staticFile(req, res),
    onError: (_e, _req, res) => send(res, { error: "Request failed" }, 500),
  });
  const financialRoutes = new Set([
    "/api/dashboard",
    "/api/accounts",
    "/api/accounts/:id",
    "/api/transactions",
    "/api/transactions/:id",
    "/api/categories",
    "/api/budgets",
    "/api/budgets/:id",
    "/api/reviews",
    "/api/reviews/:id",
    "/api/transactions/:id/audit",
    "/api/export",
  ]);
  const ledger = (req) => req.accessStore || store;
  function route(
    method,
    path,
    handler,
    { publicRoute = false, webhook = false, allowMember = false } = {},
  ) {
    app[method](path, (req, res) => {
      Promise.resolve()
        .then(async () => {
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Referrer-Policy", "no-referrer");
          res.setHeader("X-Frame-Options", "DENY");
          if (!publicRoute) {
            req.user = await auth.session(req);
            if (!req.user) return send(res, { error: "Sign in required" }, 401);
            if (
              !allowMember &&
              !financialRoutes.has(path) &&
              req.user.role !== "admin"
            )
              return send(res, { error: "Administrator access required" }, 403);
            if (financialRoutes.has(path))
              req.accessStore = await createAccessStore(store, req.user);
          }
          if (
            !webhook &&
            !["GET", "HEAD"].includes(req.method) &&
            req.headers.origin !== config.origin
          )
            return send(res, { error: "Origin not allowed" }, 403);
          req.query = Object.fromEntries(
            new URL(req.url, "http://localhost").searchParams,
          );
          const result = await handler(req, res);
          if (!res.writableEnded) send(res, result ?? { ok: true });
        })
        .catch((e) => {
          if (res.writableEnded) return;
          const status =
            e instanceof z.ZodError
              ? 400
              : e.status ||
                (["23505", "23514", "22P02"].includes(e.code) ? 400 : 500);
          send(
            res,
            {
              error:
                status < 500 || e.expose === true
                  ? e instanceof z.ZodError
                    ? "Invalid request fields"
                    : e.message
                  : "Operation failed. Check configuration and database availability.",
            },
            status,
          );
        });
    });
  }
  route(
    "get",
    "/api/health",
    async () => {
      await store.pool.query("SELECT 1");
      return { ok: true };
    },
    { publicRoute: true },
  );
  route(
    "get",
    "/api/session",
    async (req) => {
      const user = await auth.session(req);
      const setup = await auth.setupStatus();
      const permissions = user
        ? await (await createAccessStore(store, user)).permissions()
        : { financialAccess: false, manageSettings: false };
      return {
        authenticated: !!user,
        user,
        setupRequired: setup.setupRequired,
        permissions,
        demo: config.mode === "demo",
        currency: config.currency,
        timeZone: config.timezone,
      };
    },
    { publicRoute: true },
  );
  route(
    "post",
    "/api/auth/bootstrap",
    async (req, res) => {
      const result = await auth.bootstrap(
        req,
        z
          .object({
            email: z.string().max(254),
            name: z.string().max(100),
            password: z.string().max(1024),
            bootstrapToken: z.string().max(1024),
          })
          .strict()
          .parse(await body(req)),
      );
      res.setHeader("Set-Cookie", result.cookie);
      return { ok: true, user: result.user };
    },
    { publicRoute: true },
  );
  route(
    "post",
    "/api/login",
    async (req, res) => {
      const result = await auth.login(
        req,
        z
          .object({
            email: z.string().max(254),
            password: z.string().max(1024),
          })
          .strict()
          .parse(await body(req)),
      );
      res.setHeader("Set-Cookie", result.cookie);
      return { ok: true, user: result.user };
    },
    { publicRoute: true },
  );
  route(
    "post",
    "/api/logout",
    async (req, res) => {
      const result = await auth.logout(req);
      res.setHeader("Set-Cookie", result.cookie);
      return { ok: true };
    },
    { allowMember: true },
  );
  route(
    "post",
    "/api/auth/change-password",
    async (req, res) => {
      sensitive("change-password");
      const result = await auth.changePassword(
        req,
        z
          .object({
            currentPassword: z.string().max(1024),
            newPassword: z.string().max(1024),
          })
          .strict()
          .parse(await body(req)),
      );
      res.setHeader("Set-Cookie", result.cookie);
      return { ok: true };
    },
    { allowMember: true },
  );
  route(
    "post",
    "/api/auth/activate",
    async (req) => {
      await auth.rate(req, "activation");
      return users.activate(
        z
          .object({
            token: z.string().max(1024),
            password: z.string().max(1024),
            name: z.string().max(100).optional(),
          })
          .strict()
          .parse(await body(req)),
      );
    },
    { publicRoute: true },
  );
  route("get", "/api/users/grant-options", (req) =>
    users.grantOptions({ actorId: req.user.id }),
  );
  route("get", "/api/users", (req) => users.list({ actorId: req.user.id }));
  route("post", "/api/users/invitations", async (req) => {
    sensitive("invite-user");
    return users.invite({
      ...z
        .object({
          email: z.string().max(254),
          role: z.enum(["admin", "member"]),
          grants: grants.optional(),
        })
        .strict()
        .parse(await body(req)),
      actorId: req.user.id,
    });
  });
  route("post", "/api/users/invitations/:id/resend", (req) => {
    sensitive("resend-invite");
    return users.resend({ actorId: req.user.id, invitationId: req.params.id });
  });
  route("post", "/api/users/invitations/:id/revoke", (req) => {
    sensitive("revoke-invite");
    return users.revoke({ actorId: req.user.id, invitationId: req.params.id });
  });
  route("patch", "/api/users/:id", async (req) => {
    sensitive("change-role");
    return users.updateUser({
      ...z
        .object({
          role: z.enum(["admin", "member"]).optional(),
          disabled: z.boolean().optional(),
          grants: grants.optional(),
        })
        .strict()
        .parse(await body(req)),
      actorId: req.user.id,
      userId: req.params.id,
    });
  });
  route("post", "/api/users/:id/reset-password", (req) => {
    sensitive("reset-password");
    return users.resetPassword({ actorId: req.user.id, userId: req.params.id });
  });
  const filters = (req) => {
    const q = { ...req.query };
    if (
      !q.month &&
      q.ids === undefined &&
      q.allHistory !== "true" &&
      !q.from &&
      !q.to
    ) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: config.timezone,
        year: "numeric",
        month: "2-digit",
      }).formatToParts(new Date());
      q.month = `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}`;
    }
    if (q.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month))
      throw Object.assign(Error("Invalid month"), { status: 400 });
    if (q.currency && !/^[A-Z]{3}$/.test(q.currency))
      throw Object.assign(Error("Invalid currency"), { status: 400 });
    if (q.months && ![1, 2, 3, 4, 6].includes(Number(q.months)))
      throw Object.assign(Error("Invalid overview period"), { status: 400 });
    for (const field of ["from", "to"])
      if (
        q[field] &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(q[field]) ||
          !Number.isFinite(Date.parse(q[field])) ||
          new Date(q[field]).toISOString().slice(0, 10) !== q[field])
      )
        throw Object.assign(Error("Invalid date"), { status: 400 });
    if (q.from && q.to && q.from > q.to)
      throw Object.assign(Error("Invalid date range"), { status: 400 });
    return {
      ...q,
      months: Number(q.months || 1),
      currency: q.currency || config.currency,
    };
  };
  const report = async (req) => {
    if (req.query.allHistory || req.query.from || req.query.to)
      throw Object.assign(Error("Overview uses a month and period"), {
        status: 400,
      });
    const r = await ledger(req).report(filters(req));
    return {
      ...r,
      trend: r.daily?.map((d) => ({ ...d, label: d.date })),
      categories: r.categories?.map((c) => ({
        ...c,
        amountMinor: c.spentMinor,
      })),
    };
  };
  route("get", "/api/dashboard", report);
  route("get", "/api/accounts", async (req) => ({
    accounts: await ledger(req).listAccounts(),
  }));
  route("patch", "/api/accounts/:id", async (req) =>
    ledger(req).updateAccountSettings(
      req.params.id,
      z
        .object({
          label: z.string().trim().max(100).optional(),
          description: z.string().trim().max(500).optional(),
        })
        .strict()
        .parse(await body(req)),
    ),
  );
  route("get", "/api/transactions", async (req) =>
    ledger(req).transactionPage(filters(req)),
  );
  route("patch", "/api/transactions/:id", async (req) =>
    ledger(req).correctTransaction(
      req.params.id,
      correction.parse(await body(req)),
    ),
  );
  route("get", "/api/categories", async (req) => ({
    categories: await ledger(req).listCategories(),
  }));
  route("get", "/api/budgets", async (req) => {
    const r = await report(req);
    return {
      budgets: r.budgets.map((b) => ({
        ...b,
        rolloverMinor: b.carryMinor,
        rolloverEnabled: b.rollover,
      })),
      alerts: r.alerts,
    };
  });
  route("put", "/api/budgets", async (req) =>
    ledger(req).saveBudget(budget.parse(await body(req))),
  );
  route("get", "/api/rules", async () => ({ rules: await store.listRules() }));
  route("post", "/api/rules", async (req) =>
    store.saveRule(
      z
        .object({
          match: z.string().min(1).max(200),
          category,
          kind: kind.optional(),
          priority: z.number().int().min(0).max(1000).optional(),
        })
        .strict()
        .parse(await body(req)),
    ),
  );
  route("get", "/api/reviews", async (req) => ({
    reviews: await ledger(req).listReviews(),
  }));
  route("post", "/api/reviews/:id", async (req) => {
    const value = z
      .object({
        action: z.enum(["dismiss", "keep", "link"]),
        transactionId: z.string().optional(),
        pendingId: z.string().optional(),
      })
      .strict()
      .parse(await body(req));
    return ledger(req).resolveReview(req.params.id, {
      action: value.action === "dismiss" ? "keep" : value.action,
      pendingId: value.pendingId || value.transactionId,
    });
  });
  route("get", "/api/transactions/:id/audit", async (req) => ({
    audit: await ledger(req).audit(req.params.id),
  }));
  route("delete", "/api/rules/:id", (req) => store.deleteRule(req.params.id));
  route("delete", "/api/budgets/:id", (req) =>
    ledger(req).deleteBudget(req.params.id),
  );
  route("get", "/api/settings", async () => ({
    mode: config.mode,
    currency: config.currency,
    timeZone: config.timezone,
    redbark: await integration.status(),
    llm: settings
      ? await settings.getPublicProvider()
      : {
          enabled: !!(config.llmApiKey && config.llmBaseUrl && config.llmModel),
          configured: !!(
            config.llmApiKey &&
            config.llmBaseUrl &&
            config.llmModel
          ),
          automaticClassification:
            !!(config.llmApiKey && config.llmBaseUrl && config.llmModel) &&
            config.llmAutoClassify !== false,
          automaticApplication: config.llmAutoApply === true,
          dailyRequestLimit: config.llmDailyRequestLimit ?? 20,
        },
  }));
  // Demo is intentionally unauthenticated: credential storage and external actions require live auth.
  const sensitiveCalls = new Map();
  function sensitive(action) {
    if (config.mode !== "live")
      throw Object.assign(
        Error(
          "Credential settings and external actions require authenticated live mode",
        ),
        { status: 409 },
      );
    const now = Date.now();
    const prior = sensitiveCalls.get(action) || [];
    const recent = prior.filter((t) => now - t < 60000);
    if (recent.length >= 5)
      throw Object.assign(
        Error("Too many settings requests; retry in one minute"),
        { status: 429 },
      );
    recent.push(now);
    sensitiveCalls.set(action, recent);
  }
  route("get", "/api/settings/provider", () => settings.getPublicProvider());
  route("put", "/api/settings/provider", async (req) => {
    sensitive("save-provider");
    return settings.saveProvider(await body(req));
  });
  route("post", "/api/settings/provider/test-connection", async () => {
    sensitive("provider-test");
    return testProviderConnection(
      await settings.getProviderConfig(),
      providerDependencies,
    );
  });
  route("post", "/api/settings/provider/test-model", async (req) => {
    sensitive("model-test");
    z.object({ acknowledgeCost: z.literal(true) })
      .strict()
      .parse(await body(req));
    return testProviderModel(
      await settings.getProviderConfig(),
      providerDependencies,
    );
  });
  route("get", "/api/settings/webhook", () => registration.status());
  route("post", "/api/settings/webhook/register", async (req) => {
    sensitive("webhook-register");
    if (!(await integration.status()).verified)
      throw Object.assign(
        Error("Test the Redbark connection successfully before registering"),
        { status: 409 },
      );
    return registration.register(
      z
        .object({
          publicBaseUrl: z.string().max(2048),
          recoverSigningSecret: z.boolean().default(false),
        })
        .strict()
        .parse(await body(req)),
    );
  });
  route("post", "/api/settings/webhook/test", () => {
    sensitive("webhook-test");
    return registration.test();
  });
  route("get", "/api/import-health", () => importHealth.status());
  route("post", "/api/import-health/backfill", async (req) => {
    sensitive("backfill");
    return importHealth.backfill(
      z
        .object({
          accountId: z.string().min(1).max(200),
          from: z.string().max(10),
          to: z.string().max(10),
        })
        .strict()
        .parse(await body(req)),
    );
  });
  route("post", "/api/import-health/retry", async (req) => {
    sensitive("import-retry");
    return importHealth.retry(
      z
        .object({
          jobId: z.union([
            z.string().regex(/^\d+$/),
            z.number().int().positive(),
          ]),
        })
        .strict()
        .parse(await body(req)),
    );
  });
  route("get", "/api/settings/notifications", () =>
    notifications.getPublicSettings(),
  );
  route("put", "/api/settings/notifications", async (req) => {
    sensitive("notification-save");
    return notifications.saveSettings(await body(req));
  });
  route("post", "/api/notifications/test", async (req) => {
    sensitive("notification-test");
    const { channel } = z
      .object({ channel: z.enum(["smtp", "telegram"]) })
      .strict()
      .parse(await body(req));
    return notifications.testChannel(channel);
  });
  route("get", "/api/notifications/deliveries", () =>
    notifications.deliveries(),
  );
  route("post", "/api/notifications/:id/retry", (req) => {
    sensitive("notification-retry");
    return notifications.retry(req.params.id);
  });
  const pairingSession = (req) =>
    createHash("sha256")
      .update(
        (req.headers.cookie || "")
          .split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("profe_session=")) || "",
      )
      .digest("hex");
  route("get", "/api/settings/telegram/pair", (req) =>
    telegram.status({ sessionId: pairingSession(req) }),
  );
  route("post", "/api/settings/telegram/pair", (req) => {
    sensitive("telegram-pair");
    return telegram.start({ sessionId: pairingSession(req) });
  });
  route("post", "/api/settings/telegram/poll", (req) => {
    sensitive("telegram-poll");
    return telegram.poll({ sessionId: pairingSession(req) });
  });
  route("post", "/api/settings/telegram/confirm", async (req) => {
    sensitive("telegram-confirm");
    return telegram.confirm({
      ...z
        .object({
          pairingId: z.string().regex(/^[a-f0-9]{32}$/),
          chatId: z.string().regex(/^-\d{1,19}$/),
        })
        .strict()
        .parse(await body(req)),
      sessionId: pairingSession(req),
    });
  });
  route("post", "/api/connection/test", () => integration.testConnection());
  route(
    "post",
    "/api/webhooks/redbark",
    async (req) =>
      integration.receiveWebhook(await body(req, true), req.headers),
    { publicRoute: true, webhook: true },
  );
  route("post", "/api/transactions/:id/suggest", async (req) => {
    await (
      await createAccessStore(store, req.user)
    ).assertTransaction(req.params.id, "edit");
    return classification.suggest(req.params.id);
  });
  route("get", "/api/export", async (req, res) => {
    const f = filters(req);
    const snapshot = await ledger(req).exportSnapshot(f);
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="profe-export.json"',
    );
    return {
      exportedAt: new Date().toISOString(),
      mode: config.mode,
      ...snapshot,
    };
  });
  async function staticFile(req, res) {
    if (req.url.startsWith("/api/"))
      return send(res, { error: "Not found" }, 404);
    if (req.method !== "GET") return send(res, { error: "Not found" }, 404);
    try {
      const root = resolve("frontend/dist");
      const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      const path = resolve(root, "." + pathname);
      if (!path.startsWith(root + "/") && path !== root)
        return send(res, { error: "Not found" }, 404);
      let data;
      let ext = extname(path);
      try {
        data = await readFile(path);
      } catch {
        if (ext) return send(res, { error: "Not found" }, 404);
        data = await readFile(resolve(root, "index.html"));
        ext = ".html";
      }
      res.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
          }[ext] || "application/octet-stream",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      });
      res.end(data);
    } catch {
      send(res, { error: "Frontend not built. Run npm run build." }, 503);
    }
  }
  return app;
}
