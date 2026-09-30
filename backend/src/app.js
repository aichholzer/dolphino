import rayo from "rayo";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { z } from "zod";
import { createAuth } from "./auth.js";
import { suggestCategory } from "./llm.js";
const minor = z.string().regex(/^-?\d{1,18}$/);
const category = z.string().trim().min(1).max(100);
const kind = z.enum(["expense", "income", "transfer", "refund"]);
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
export function createApp({ store, integration, config }) {
  const auth = createAuth(config);
  const app = rayo({
    host: config.host,
    port: config.port,
    notFound: (req, res) => staticFile(req, res),
    onError: (_e, _req, res) => send(res, { error: "Request failed" }, 500),
  });
  function route(
    method,
    path,
    handler,
    { publicRoute = false, webhook = false } = {},
  ) {
    app[method](path, (req, res) => {
      Promise.resolve()
        .then(async () => {
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Referrer-Policy", "no-referrer");
          res.setHeader("X-Frame-Options", "DENY");
          if (!publicRoute && !auth.authenticated(req))
            return send(res, { error: "Sign in required" }, 401);
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
                status < 500
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
    (req) => ({
      authenticated: auth.authenticated(req),
      demo: config.mode === "demo",
      currency: config.currency,
      timeZone: config.timezone,
    }),
    { publicRoute: true },
  );
  route(
    "post",
    "/api/login",
    async (req, res) => {
      const { password } = z
        .object({ password: z.string().max(1024) })
        .parse(await body(req));
      const result = auth.login(req, password);
      if (result.error)
        return send(res, { error: result.error }, result.status);
      res.setHeader("Set-Cookie", result.cookie);
      return { ok: true };
    },
    { publicRoute: true },
  );
  route("post", "/api/logout", (_req, res) => {
    res.setHeader("Set-Cookie", auth.logoutCookie);
    return { ok: true };
  });
  const filters = (req) => {
    const q = { ...req.query };
    if (!q.month) {
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
    return { ...q, currency: q.currency || config.currency };
  };
  const report = async (req) => {
    const r = await store.report(filters(req));
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
  route("get", "/api/accounts", async () => ({
    accounts: await store.listAccounts(),
  }));
  route("get", "/api/transactions", async (req) => ({
    transactions: await store.listTransactions(filters(req)),
  }));
  route("patch", "/api/transactions/:id", async (req) =>
    store.correctTransaction(req.params.id, correction.parse(await body(req))),
  );
  route("get", "/api/categories", async () => ({
    categories: await store.listCategories(),
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
    store.saveBudget(budget.parse(await body(req))),
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
  route("get", "/api/reviews", async () => ({
    reviews: await store.listReviews(),
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
    return store.resolveReview(req.params.id, {
      action: value.action === "dismiss" ? "keep" : value.action,
      pendingId: value.pendingId || value.transactionId,
    });
  });
  route("get", "/api/transactions/:id/audit", async (req) => ({
    audit: await store.audit(req.params.id),
  }));
  route("delete", "/api/rules/:id", (req) => store.deleteRule(req.params.id));
  route("delete", "/api/budgets/:id", (req) =>
    store.deleteBudget(req.params.id),
  );
  route("get", "/api/settings", async () => ({
    mode: config.mode,
    currency: config.currency,
    timeZone: config.timezone,
    redbark: await integration.status(),
    llm: {
      enabled: !!(config.llmApiKey && config.llmBaseUrl && config.llmModel),
      configured: !!(config.llmApiKey && config.llmBaseUrl && config.llmModel),
    },
  }));
  route("post", "/api/connection/test", () => integration.testConnection());
  route(
    "post",
    "/api/webhooks/redbark",
    async (req) =>
      integration.receiveWebhook(await body(req, true), req.headers),
    { publicRoute: true, webhook: true },
  );
  route("post", "/api/transactions/:id/suggest", async (req) => {
    const transactions = await store.listTransactions({});
    const tx = transactions.find((t) => t.id === req.params.id);
    if (!tx)
      throw Object.assign(Error("Transaction not found"), { status: 404 });
    return suggestCategory(tx, await store.listCategories(), config);
  });
  route("get", "/api/export", async (req, res) => {
    const f = filters(req);
    const snapshot = await store.exportSnapshot(f);
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
