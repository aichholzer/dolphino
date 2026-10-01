import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  calculateReport,
  calculatePeriodReport,
  calculateSelectionReport,
  classify,
  minor,
  validateSplits,
  KINDS,
  domainError,
} from "./engine.js";
import { demoData } from "./demo.js";
const dateString = (d) =>
  d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    : String(d).slice(0, 10);
const classificationReview = (reason) =>
  reason === "Category needs review" ||
  reason?.startsWith("Classification review:");
const ruleResolvesReview = (reason, description, rules) => {
  const matched = [...rules]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .find((r) => description.toLowerCase().includes(r.contains.toLowerCase()));
  return !!matched && (reason === "Category needs review" || !!matched.kind);
};
const txRow = (r) => ({
  id: r.id,
  accountId: r.account_id,
  supersededBy: r.superseded_by || null,
  accountName: r.account_name,
  currency: r.currency,
  amountMinor: String(r.amount_minor),
  status: r.status,
  date: dateString(r.date),
  description: r.description,
  providerCategory: r.provider_category,
  category:
    r.override_category ||
    (r.classification_category !== "Uncategorized"
      ? r.classification_category
      : null) ||
    r.ai_category ||
    r.provider_category ||
    "Uncategorized",
  kind: r.override_kind || r.kind,
  internalTransfer: r.kind === "transfer" || r.override_kind === "transfer",
  splits: r.splits || [],
  note: r.note || "",
  reviewReason: r.review_reason,
  reviewRequired: !!r.review_reason,
  fetchedAt: r.fetched_at,
  manuallyCorrected: !!r.override_id,
});
const txSelect = `SELECT t.*,COALESCE(a.local_label,a.name) account_name,o.transaction_id override_id,o.category override_category,o.kind override_kind,o.splits,o.note FROM transactions t JOIN accounts a ON a.mode=t.mode AND a.id=t.account_id LEFT JOIN transaction_overrides o ON o.transaction_id=t.id`;
const budgetRow = (r) => ({
  id: r.id,
  category: r.category,
  currency: r.currency,
  month: r.month,
  capMinor: String(r.cap_minor),
  allocationMinor: String(r.allocation_minor),
  rollover: r.rollover,
  rolloverEnabled: r.rollover,
});
const ruleRow = (r) => ({
  id: r.id,
  contains: r.contains,
  match: r.contains,
  category: r.category,
  kind: r.kind,
  priority: r.priority,
});
export class Store {
  constructor(pool, { mode = "demo", timezone = "Australia/Brisbane" } = {}) {
    this.pool = pool;
    this.mode = mode;
    this.timezone = timezone;
  }
  async migrate() {
    for (const name of [
      "001_core.sql",
      "002_alerts.sql",
      "003_automatic_classification.sql",
      "004_accounts.sql",
      "005_settings.sql",
      "006_alert_notifications.sql",
      "010_grants.sql",
      "012_simplefin.sql",
    ])
      await this.pool.query(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
  }
  async atomic(fn, { refresh = true, client } = {}) {
    const c = client || (await this.pool.connect());
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `profe:${this.mode}`,
      ]);
      const result = await fn(c);
      if (refresh) await this.refreshAlerts(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      if (!client) c.release();
    }
  }
  async updateAccount(account, coverage = null, c = this.pool) {
    if (!account.id || !/^[A-Z]{3}$/.test(account.currency))
      throw domainError("Account id and currency required");
    if (account.balanceMinor != null) minor(account.balanceMinor);
    await c.query(
      `INSERT INTO accounts(mode,id,name,currency,balance_minor,balance_type,balance_at,fetched_at,coverage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(mode,id) DO UPDATE SET name=excluded.name,currency=excluded.currency,balance_minor=COALESCE(excluded.balance_minor,accounts.balance_minor),balance_type=COALESCE(excluded.balance_type,accounts.balance_type),balance_at=COALESCE(excluded.balance_at,accounts.balance_at),fetched_at=GREATEST(excluded.fetched_at,accounts.fetched_at),coverage=COALESCE(excluded.coverage,accounts.coverage) WHERE excluded.fetched_at >= accounts.fetched_at`,
      [
        this.mode,
        account.id,
        account.name || account.id,
        account.currency,
        account.balanceMinor ?? null,
        account.balanceType ?? null,
        account.balanceAt ?? null,
        account.fetchedAt || new Date().toISOString(),
        coverage,
      ],
    );
  }
  async ingestBatch({
    account,
    transactions = [],
    fetchedAt = new Date().toISOString(),
    coverage = null,
  }) {
    return this.atomic(async (c) => {
      if (this.mode === "live") {
        const owner = (
          await c.query(
            "SELECT source_id FROM simplefin_accounts WHERE local_id=$1",
            [account.id],
          )
        ).rows[0];
        if (
          owner &&
          transactions.some(
            (t) => t.provider !== `simplefin:${owner.source_id}`,
          )
        )
          throw domainError("Account belongs to another import source");
        if (owner && !transactions.length)
          throw domainError("Account belongs to another import source");
      }
      await this.updateAccount({ ...account, fetchedAt }, coverage, c);
      const result = [];
      for (const t of transactions)
        result.push(
          await this._ingest(c, {
            ...t,
            accountId: account.id,
            accountName: account.name,
            currency: t.currency || account.currency,
            fetchedAt: t.fetchedAt || fetchedAt,
          }),
        );
      return result;
    });
  }
  async ingest(observation) {
    return this.atomic((c) => this._ingest(c, observation));
  }
  async _ingest(c, o) {
    if (o.mode && o.mode !== this.mode)
      throw domainError("Observation mode does not match store");
    if (
      !o.accountId ||
      !o.sourceId ||
      !o.description ||
      !/^\d{4}-\d{2}-\d{2}$/.test(o.date) ||
      !["pending", "posted"].includes(o.status) ||
      !/^[A-Z]{3}$/.test(o.currency)
    )
      throw domainError("Invalid normalized observation");
    minor(o.amountMinor);
    if (o.kind && !KINDS.includes(o.kind))
      throw domainError("Invalid transaction kind");
    const provider = o.provider || "redbark",
      fetchedAt = o.fetchedAt || new Date().toISOString();
    if (!Number.isFinite(Date.parse(fetchedAt)))
      throw domainError("Invalid fetch timestamp");
    await c.query(
      `INSERT INTO accounts(mode,id,name,currency,fetched_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(mode,id) DO NOTHING`,
      [
        this.mode,
        o.accountId,
        o.accountName || o.accountId,
        o.currency,
        fetchedAt,
      ],
    );
    let existing = (
      await c.query(
        `SELECT t.* FROM source_aliases a JOIN transactions t ON t.id=a.transaction_id WHERE a.mode=$1 AND a.provider=$2 AND a.account_id=$3 AND a.source_id=$4`,
        [this.mode, provider, o.accountId, o.sourceId],
      )
    ).rows[0];
    let reason = o.reviewReason || null;
    if (!existing && o.replacesSourceId) {
      const prior = (
        await c.query(
          `SELECT t.* FROM source_aliases a JOIN transactions t ON t.id=a.transaction_id WHERE a.mode=$1 AND a.provider=$2 AND a.account_id=$3 AND a.source_id=$4`,
          [this.mode, provider, o.accountId, o.replacesSourceId],
        )
      ).rows[0];
      if (prior?.status === "pending" && prior.currency === o.currency)
        existing = prior;
      else reason = "Provider replacement could not be linked safely";
    }
    if (!existing && o.status === "posted" && !o.replacesSourceId) {
      const pending = await c.query(
        `SELECT id FROM transactions WHERE mode=$1 AND account_id=$2 AND currency=$3 AND amount_minor=$4 AND status='pending' AND date BETWEEN $5::date-INTERVAL '7 days' AND $5::date`,
        [this.mode, o.accountId, o.currency, o.amountMinor, o.date],
      );
      if (pending.rowCount) {
        reason =
          "Possible pending replacement: review source identity; no automatic merge";
        await c.query(
          `UPDATE transactions SET review_reason=COALESCE(review_reason,'Possible posted replacement: review source identity') WHERE id=ANY($1::uuid[])`,
          [pending.rows.map((r) => r.id)],
        );
      }
    }
    const id = existing?.id || randomUUID();
    const rules = (
      await c.query(
        "SELECT * FROM rules WHERE mode=$1 ORDER BY priority DESC,id",
        [this.mode],
      )
    ).rows.map(ruleRow);
    const classification = classify(o, rules);
    // Re-fetching unchanged evidence must not undo an explicit review decision.
    const unchanged =
      existing &&
      existing.currency === o.currency &&
      String(existing.amount_minor) === o.amountMinor &&
      existing.status === o.status &&
      existing.kind === classification.kind &&
      dateString(existing.date) === o.date &&
      existing.description === o.description &&
      (existing.provider_category || null) === (o.category || null);
    if (
      classificationReview(reason) &&
      (ruleResolvesReview(reason, o.description, rules) ||
        (unchanged && !existing.review_reason))
    )
      reason = null;
    // A category hint must never replace an outstanding source-identity warning.
    if (
      existing?.review_reason &&
      !classificationReview(existing.review_reason) &&
      classificationReview(reason)
    )
      reason = existing.review_reason;
    if (!existing)
      await c.query(
        `INSERT INTO transactions(id,mode,account_id,currency,amount_minor,status,date,description,provider_category,classification_category,kind,fetched_at,review_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          this.mode,
          o.accountId,
          o.currency,
          o.amountMinor,
          o.status,
          o.date,
          o.description,
          o.category || null,
          classification.category,
          classification.kind,
          fetchedAt,
          reason ||
            (classification.category === "Uncategorized"
              ? "Category needs review"
              : null),
        ],
      );
    // Fetch order is monotonic. Late pending observations cannot regress a posted canonical record.
    else if (
      Date.parse(fetchedAt) >= Date.parse(existing.fetched_at) &&
      !(existing.status === "posted" && o.status === "pending")
    ) {
      if (!unchanged)
        await c.query("UPDATE transactions SET ai_category=NULL WHERE id=$1", [
          id,
        ]);
      const override = (
        await c.query(
          "SELECT splits FROM transaction_overrides WHERE transaction_id=$1",
          [id],
        )
      ).rows[0];
      if (
        !unchanged &&
        classification.category === "Uncategorized" &&
        !override &&
        !reason
      )
        reason = "Category needs review";
      if (override?.splits?.length) {
        try {
          validateSplits(override.splits, o.amountMinor);
        } catch {
          reason =
            "Provider amount changed; existing manual splits need review";
        }
      }
      await c.query(
        `UPDATE transactions SET currency=$2,amount_minor=$3,status=$4,date=$5,description=$6,provider_category=$7,classification_category=$8,kind=$9,fetched_at=$10,review_reason=COALESCE($11,review_reason) WHERE id=$1`,
        [
          id,
          o.currency,
          o.amountMinor,
          o.status,
          o.date,
          o.description,
          o.category || null,
          classification.category,
          classification.kind,
          fetchedAt,
          reason,
        ],
      );
      // Never allow stale splits to corrupt reports; preserve their value in audit before clearing.
      if (
        reason === "Provider amount changed; existing manual splits need review"
      ) {
        await c.query(
          `INSERT INTO audit_history(mode,transaction_id,action,before_value,after_value) VALUES($1,$2,'split-invalidated',$3,$4)`,
          [this.mode, id, override, { splits: null }],
        );
        await c.query(
          "UPDATE transaction_overrides SET splits=NULL WHERE transaction_id=$1",
          [id],
        );
      }
    }
    await c.query(
      `INSERT INTO source_aliases(mode,provider,account_id,source_id,transaction_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [this.mode, provider, o.accountId, o.sourceId, id],
    );
    const payload = { ...o, fetchedAt };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    await c.query(
      `INSERT INTO provider_observations(mode,provider,account_id,source_id,transaction_id,fetched_at,payload,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        this.mode,
        provider,
        o.accountId,
        o.sourceId,
        id,
        fetchedAt,
        payload,
        fingerprint,
      ],
    );
    return txRow((await c.query(`${txSelect} WHERE t.id=$1`, [id])).rows[0]);
  }
  async listTransactions(filters = {}, c = this.pool) {
    const values = [this.mode],
      clauses = ["t.mode=$1", "t.superseded_by IS NULL"];
    const add = (sql, value) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (
      filters.month &&
      filters.allHistory !== true &&
      filters.allHistory !== "true"
    ) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filters.month))
        throw domainError("Invalid month");
      add("to_char(t.date,'YYYY-MM')=?", filters.month);
    }
    for (const key of ["from", "to"]) {
      if (filters[key]) {
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(filters[key]) ||
          !Number.isFinite(Date.parse(filters[key])) ||
          new Date(filters[key]).toISOString().slice(0, 10) !== filters[key]
        )
          throw domainError("Invalid date");
        add(`t.date${key === "from" ? ">=" : "<="}?::date`, filters[key]);
      }
    }
    if (filters.from && filters.to && filters.from > filters.to)
      throw domainError("Date range is reversed");
    if (filters.currency) add("t.currency=?", filters.currency);
    if (filters.accountId || filters.account)
      add("t.account_id=?", filters.accountId || filters.account);
    if (filters.accountIds !== undefined)
      add("t.account_id=ANY(?::text[])", filters.accountIds);
    if (filters.status) add("t.status=?", filters.status);
    if (filters.kind) add("COALESCE(o.kind,t.kind)=?", filters.kind);
    if (filters.category) {
      values.push(filters.category);
      const categoryCondition = `((COALESCE(jsonb_array_length(o.splits),0)=0 AND COALESCE(o.category,NULLIF(t.classification_category,'Uncategorized'),t.ai_category,t.provider_category,'Uncategorized')=$${values.length}) OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.splits,'[]'::jsonb)) split WHERE split->>'category'=$${values.length}))`;
      clauses.push(
        filters.redactTransfers
          ? `((COALESCE(o.kind='transfer',false) OR t.kind='transfer') AND $${values.length}='Transfers' OR (NOT(COALESCE(o.kind='transfer',false) OR t.kind='transfer') AND ${categoryCondition}))`
          : categoryCondition,
      );
    }
    if (filters.q || filters.search)
      add(
        filters.redactTransfers
          ? "(CASE WHEN (o.kind='transfer' OR t.kind='transfer') THEN 'Internal transfer' ELSE t.description END) ILIKE ?"
          : "t.description ILIKE ?",
        `%${filters.q || filters.search}%`,
      );
    if (filters.review)
      (add("t.review_reason IS NOT NULL", null), values.pop());
    if (filters.ids !== undefined) {
      const ids = Array.isArray(filters.ids)
        ? filters.ids
        : filters.ids === ""
          ? []
          : String(filters.ids).split(",");
      add("t.id=ANY(?::uuid[])", ids);
    }
    const where = clauses.join(" AND ");
    if (filters.paginated) {
      const page = Number(filters.page || 1),
        pageSize = Number(filters.pageSize || 50);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      )
        throw domainError("Invalid pagination");
      const total = Number(
        (
          await c.query(
            `SELECT count(*) total FROM transactions t JOIN accounts a ON a.mode=t.mode AND a.id=t.account_id LEFT JOIN transaction_overrides o ON o.transaction_id=t.id WHERE ${where}`,
            values,
          )
        ).rows[0].total,
      );
      const rows = (
        await c.query(
          `${txSelect} WHERE ${where} ORDER BY t.date DESC,t.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, pageSize, (page - 1) * pageSize],
        )
      ).rows;
      return {
        transactions: rows.map(txRow),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    }
    return (
      await c.query(
        `${txSelect} WHERE ${where} ORDER BY t.date DESC,t.id`,
        values,
      )
    ).rows.map(txRow);
  }
  async transactionPage(filters = {}) {
    return this.atomic(
      (c) => this.listTransactions({ ...filters, paginated: true }, c),
      { refresh: false },
    );
  }

  async getTransaction(id, c = this.pool) {
    const r = (
      await c.query(`${txSelect} WHERE t.mode=$1 AND t.id=$2`, [this.mode, id])
    ).rows[0];
    if (!r) throw domainError("Transaction not found");
    return txRow(r);
  }
  async correctTransaction(id, patch) {
    await this.atomic(async (c) => {
      const current = (
        await c.query(
          `${txSelect} WHERE t.mode=$1 AND t.id=$2 FOR UPDATE OF t`,
          [this.mode, id],
        )
      ).rows[0];
      if (!current) throw domainError("Transaction not found");
      if (
        patch.category != null &&
        (typeof patch.category !== "string" ||
          !patch.category.trim() ||
          patch.category.length > 100)
      )
        throw domainError("Invalid category");
      if (patch.kind != null && !KINDS.includes(patch.kind))
        throw domainError("Invalid kind");
      if (
        patch.note != null &&
        (typeof patch.note !== "string" || patch.note.length > 2000)
      )
        throw domainError("Note is too long");
      const before =
        (
          await c.query(
            "SELECT * FROM transaction_overrides WHERE transaction_id=$1",
            [id],
          )
        ).rows[0] || {};
      const after = {
        category:
          patch.category === undefined ? before.category : patch.category,
        kind: patch.kind === undefined ? before.kind : patch.kind,
        splits: patch.splits === undefined ? before.splits : patch.splits,
        note: patch.note === undefined ? before.note : patch.note,
      };
      validateSplits(after.splits, String(current.amount_minor));
      await c.query(
        `INSERT INTO transaction_overrides(transaction_id,category,kind,splits,note) VALUES($1,$2,$3,$4,$5) ON CONFLICT(transaction_id) DO UPDATE SET category=excluded.category,kind=excluded.kind,splits=excluded.splits,note=excluded.note,updated_at=now()`,
        [
          id,
          after.category || null,
          after.kind || null,
          after.splits ? JSON.stringify(after.splits) : null,
          after.note || null,
        ],
      );
      await c.query(
        `INSERT INTO audit_history(mode,transaction_id,action,before_value,after_value) VALUES($1,$2,'correction',$3,$4)`,
        [this.mode, id, before, after],
      );
      if (patch.category || patch.splits || patch.kind)
        await c.query(
          "UPDATE transactions SET review_reason=NULL WHERE id=$1 AND review_reason NOT ILIKE '%replacement%' AND review_reason NOT ILIKE '%identity%'",
          [id],
        );
    });
    return this.getTransaction(id);
  }
  async updateAccountSettings(id, patch) {
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some((k) => !["label", "description"].includes(k))
    )
      throw domainError("Invalid account settings");
    for (const key of ["label", "description"])
      if (
        patch[key] !== undefined &&
        (typeof patch[key] !== "string" ||
          patch[key].length > (key === "label" ? 100 : 1000))
      )
        throw domainError("Invalid account " + key);
    return this.atomic(async (c) => {
      const before = (
        await c.query(
          "SELECT * FROM accounts WHERE mode=$1 AND id=$2 FOR UPDATE",
          [this.mode, id],
        )
      ).rows[0];
      if (!before) throw domainError("Account not found");
      await c.query(
        "UPDATE accounts SET local_label=$3,description=$4 WHERE mode=$1 AND id=$2",
        [
          this.mode,
          id,
          patch.label === undefined
            ? before.local_label
            : patch.label.trim() || null,
          patch.description ?? before.description,
        ],
      );
      const after = (await this.listAccounts(c)).find((a) => a.id === id);
      if (
        before.local_label !== (after.label || null) ||
        before.description !== after.description
      )
        await c.query(
          "INSERT INTO audit_history(mode,action,before_value,after_value) VALUES($1,'account-settings',$2,$3)",
          [
            this.mode,
            {
              accountId: id,
              label: before.local_label,
              description: before.description,
            },
            {
              accountId: id,
              label: after.label,
              description: after.description,
            },
          ],
        );
      return after;
    });
  }
  async listAccounts(c = this.pool) {
    return (
      await c.query("SELECT * FROM accounts WHERE mode=$1 ORDER BY name", [
        this.mode,
      ])
    ).rows.map((r) => ({
      id: r.id,
      name: r.local_label || r.name,
      providerName: r.name,
      label: r.local_label || "",
      description: r.description,
      currency: r.currency,
      balanceMinor: r.balance_minor == null ? null : String(r.balance_minor),
      balanceType: r.balance_type,
      balanceAt: r.balance_at,
      fetchedAt: r.fetched_at,
      coverage: r.coverage,
      reconciled: false,
      reconciliationReason:
        "Not reconciled: no verified opening balance with matching type, time and complete transaction coverage.",
    }));
  }
  async report({ month, currency = "AUD", months = 1 }, client) {
    const calculate = async (c) => {
      const transactions = await this.listTransactions({ currency }, c),
        budgets = await this.listBudgets(c),
        accounts = await this.listAccounts(c);
      const report = calculatePeriodReport(transactions, budgets, {
        month,
        currency,
        months,
        today: new Intl.DateTimeFormat("en-CA", {
          timeZone: this.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date()),
      });
      return {
        ...report,
        accounts,
        coverage: {
          accounts: accounts
            .filter((a) => a.currency === currency)
            .map((a) => ({
              accountId: a.id,
              fetchedAt: a.fetchedAt,
              coverage: a.coverage,
              reconciled: false,
              reason: a.reconciliationReason,
            })),
          complete: false,
          reason:
            "Imported date windows only; source balances are independent snapshots.",
        },
      };
    };
    return client
      ? calculate(client)
      : this.atomic(calculate, { refresh: false });
  }
  // Recompute every configured budget period, including later rollover periods and
  // removed budgets with persisted alerts, inside the financial write transaction.
  async refreshAlerts(c) {
    const budgets = await this.listBudgets(c);
    const periods = new Map(
      budgets.map((b) => [`${b.currency}:${b.month}`, b]),
    );
    for (const row of (
      await c.query(
        "SELECT DISTINCT currency,month FROM budget_alerts WHERE mode=$1",
        [this.mode],
      )
    ).rows)
      periods.set(`${row.currency}:${row.month}`, row);
    if (!periods.size) return;
    const transactions = await this.listTransactions({}, c);
    for (const { month, currency } of [...periods.values()].sort(
      (a, b) =>
        a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency),
    ))
      await this.persistAlerts(
        calculateReport(transactions, budgets, { month, currency }),
        c,
      );
  }
  // Reconcile durable alert state with the same atomic snapshot used by reports.
  // A stable natural key prevents concurrent/repeated mutations from generating duplicates.
  async persistAlerts(report, c) {
    const emit = async (row, state) => {
      await c.query(
        `INSERT INTO notification_events(alert_id,revision,mode,payload) VALUES($1,$2,$3,$4) ON CONFLICT(alert_id,revision) DO NOTHING`,
        [
          row.id,
          row.revision,
          this.mode,
          {
            category: row.category,
            month: row.month,
            currency: row.currency,
            amountMinor: String(row.amount_minor),
            state,
          },
        ],
      );
    };
    const categories = report.alerts.map((alert) => alert.category);
    const resolved = await c.query(
      `UPDATE budget_alerts SET resolved_at=now(),updated_at=now(),revision=revision+1 WHERE mode=$1 AND currency=$2 AND month=$3 AND type='overspend' AND resolved_at IS NULL AND NOT(category=ANY($4::text[])) RETURNING *`,
      [this.mode, report.currency, report.month, categories],
    );
    for (const row of resolved.rows) await emit(row, "resolved");
    for (const alert of report.alerts) {
      const prior = (
        await c.query(
          `SELECT * FROM budget_alerts WHERE mode=$1 AND currency=$2 AND month=$3 AND category=$4 AND type=$5 FOR UPDATE`,
          [
            this.mode,
            report.currency,
            report.month,
            alert.category,
            alert.type,
          ],
        )
      ).rows[0];
      const updated = await c.query(
        `INSERT INTO budget_alerts(id,mode,currency,month,category,type,amount_minor,message) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(mode,currency,month,category,type) DO UPDATE SET amount_minor=excluded.amount_minor,message=excluded.message,resolved_at=NULL,updated_at=now(),revision=budget_alerts.revision+CASE WHEN budget_alerts.resolved_at IS NOT NULL THEN 1 ELSE 0 END WHERE budget_alerts.amount_minor IS DISTINCT FROM excluded.amount_minor OR budget_alerts.message IS DISTINCT FROM excluded.message OR budget_alerts.resolved_at IS NOT NULL RETURNING *`,
        [
          randomUUID(),
          this.mode,
          report.currency,
          report.month,
          alert.category,
          alert.type,
          alert.amountMinor,
          alert.message,
        ],
      );
      if (updated.rows[0] && (!prior || prior.resolved_at))
        await emit(updated.rows[0], prior ? "reopened" : "opened");
    }
  }
  async exportSnapshot(filters) {
    return this.atomic(
      async (c) => {
        const ranged =
          filters.allHistory === true ||
          filters.allHistory === "true" ||
          filters.from ||
          filters.to;
        const summary = ranged ? null : await this.report(filters, c);
        // Pagination is a presentation concern; exports contain the complete selection.
        const selection = { ...filters, paginated: false };
        if (summary) {
          delete selection.month;
          selection.from = summary.startDate;
          selection.to = summary.endDate;
        } else if (filters.allHistory === true || filters.allHistory === "true")
          delete selection.month;
        const transactions = await this.listTransactions(selection, c);
        const selectionSummary = calculateSelectionReport(transactions, {
          ...selection,
          month: filters.month,
        });
        return {
          filters,
          summaryScope: summary
            ? "All imported transactions in the selected calendar period and currency; selectionSummary applies optional transaction filters"
            : "Exactly the exported transaction selection and currency",
          summary: summary || selectionSummary,
          selectionSummary,
          transactions,
        };
      },
      { refresh: false },
    );
  }
  async listBudgets(c = this.pool) {
    return (
      await c.query(
        "SELECT * FROM budgets WHERE mode=$1 ORDER BY month,category",
        [this.mode],
      )
    ).rows.map(budgetRow);
  }
  async saveBudget(b) {
    minor(b.capMinor);
    minor(b.allocationMinor || "0");
    if (
      minor(b.capMinor) < 0n ||
      minor(b.allocationMinor || "0") < 0n ||
      !b.category?.trim() ||
      b.category.length > 100 ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month) ||
      !/^[A-Z]{3}$/.test(b.currency || "AUD")
    )
      throw domainError("Invalid budget");
    return this.atomic(async (c) => {
      const r = await c.query(
        `INSERT INTO budgets(id,mode,category,currency,month,cap_minor,allocation_minor,rollover) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(mode,category,currency,month) DO UPDATE SET cap_minor=excluded.cap_minor,allocation_minor=excluded.allocation_minor,rollover=excluded.rollover RETURNING *`,
        [
          randomUUID(),
          this.mode,
          b.category,
          b.currency || "AUD",
          b.month,
          b.capMinor,
          b.allocationMinor || "0",
          b.rolloverEnabled ?? b.rollover ?? false,
        ],
      );
      return budgetRow(r.rows[0]);
    });
  }
  async deleteBudget(id) {
    return this.atomic(async (c) => {
      await c.query("DELETE FROM budgets WHERE mode=$1 AND id=$2", [
        this.mode,
        id,
      ]);
      return { ok: true };
    });
  }
  async listRules() {
    return (
      await this.pool.query(
        "SELECT * FROM rules WHERE mode=$1 ORDER BY priority DESC,id",
        [this.mode],
      )
    ).rows.map(ruleRow);
  }
  async saveRule(r) {
    const contains = r.contains || r.match;
    if (
      typeof contains !== "string" ||
      !contains.trim() ||
      contains.length > 200 ||
      !r.category?.trim() ||
      r.category.length > 100 ||
      (r.kind && !KINDS.includes(r.kind))
    )
      throw domainError("Invalid rule");
    return this.atomic(async (c) => {
      const saved = await c.query(
        `INSERT INTO rules(id,mode,contains,category,kind,priority) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(mode,contains) DO UPDATE SET category=excluded.category,kind=excluded.kind,priority=excluded.priority RETURNING *`,
        [
          randomUUID(),
          this.mode,
          contains,
          r.category,
          r.kind || null,
          r.priority || 0,
        ],
      );
      await this.reclassify(c);
      return ruleRow(saved.rows[0]);
    });
  }
  async deleteRule(id) {
    return this.atomic(async (c) => {
      await c.query("DELETE FROM rules WHERE mode=$1 AND id=$2", [
        this.mode,
        id,
      ]);
      await this.reclassify(c);
      return { ok: true };
    });
  }
  async reclassify(c) {
    const rules = (
      await c.query("SELECT * FROM rules WHERE mode=$1", [this.mode])
    ).rows.map(ruleRow);
    for (const row of (
      await c.query("SELECT * FROM transactions WHERE mode=$1", [this.mode])
    ).rows) {
      const latest = (
        await c.query(
          "SELECT payload FROM provider_observations WHERE transaction_id=$1 ORDER BY fetched_at DESC,id DESC LIMIT 1",
          [row.id],
        )
      ).rows[0]?.payload;
      const result = classify(
        {
          description: row.description,
          amountMinor: String(row.amount_minor),
          category: row.provider_category,
          kind: latest?.kind,
        },
        rules,
      );
      await c.query(
        "UPDATE transactions SET classification_category=$2,kind=$3,ai_category=CASE WHEN $2 <> 'Uncategorized' OR kind <> $3 THEN NULL ELSE ai_category END,review_reason=CASE WHEN $4 THEN NULL ELSE review_reason END WHERE id=$1",
        [
          row.id,
          result.category,
          result.kind,
          classificationReview(row.review_reason) &&
            ruleResolvesReview(row.review_reason, row.description, rules),
        ],
      );
    }
  }
  async listCategories(c = this.pool) {
    const rows = await this.listTransactions({}, c);
    const configured = (
      await c.query(
        "SELECT category FROM budgets WHERE mode=$1 UNION SELECT category FROM rules WHERE mode=$1",
        [this.mode],
      )
    ).rows;
    return [
      ...new Set([
        "Uncategorized",
        "Groceries",
        "Dining",
        "Transport",
        "Housing",
        "Utilities",
        "Shopping",
        "Entertainment",
        "Health",
        "Income",
        ...rows.map((t) => t.category),
        ...configured.map((r) => r.category),
      ]),
    ].sort();
  }
  async isAutomaticClassificationEligible(tx, c = this.pool) {
    if (
      tx.supersededBy ||
      tx.status !== "posted" ||
      tx.category !== "Uncategorized" ||
      tx.manuallyCorrected ||
      tx.kind === "transfer" ||
      (tx.providerCategory && tx.providerCategory !== "Uncategorized") ||
      (tx.reviewReason && tx.reviewReason !== "Category needs review")
    )
      return false;
    const rows = (
      await c.query("SELECT contains FROM rules WHERE mode=$1", [this.mode])
    ).rows;
    return !rows.some((r) =>
      tx.description.toLowerCase().includes(r.contains.toLowerCase()),
    );
  }
  async automaticClassificationCandidates(c = this.pool) {
    const candidates = await this.listTransactions(
      { status: "posted", category: "Uncategorized" },
      c,
    );
    const result = [];
    for (const tx of candidates)
      if (await this.isAutomaticClassificationEligible(tx, c)) result.push(tx);
    return result;
  }
  async markAutomaticClassificationReview(id, expectedTx, client) {
    return this.atomic(
      async (c) => {
        const tx = (await this.listTransactions({ ids: [id] }, c))[0];
        const keys = [
          "description",
          "amountMinor",
          "status",
          "kind",
          "providerCategory",
          "category",
          "currency",
          "date",
        ];
        if (
          !tx ||
          !(await this.isAutomaticClassificationEligible(tx, c)) ||
          keys.some((k) => tx[k] !== expectedTx[k])
        )
          return false;
        await c.query(
          "UPDATE transactions SET review_reason='Category needs review' WHERE id=$1 AND review_reason IS NULL",
          [id],
        );
        return true;
      },
      { client, refresh: false },
    );
  }
  async acceptAutomaticClassification(id, category, expectedTx, client) {
    return this.atomic(
      async (c) => {
        const tx = (await this.listTransactions({ ids: [id] }, c))[0];
        const keys = [
          "description",
          "amountMinor",
          "status",
          "kind",
          "providerCategory",
          "category",
          "currency",
          "date",
        ];
        if (
          !tx ||
          !(await this.isAutomaticClassificationEligible(tx, c)) ||
          keys.some((k) => tx[k] !== expectedTx[k])
        )
          return { applied: false, reason: "transaction_changed_or_resolved" };
        if (
          category === "Uncategorized" ||
          !(await this.listCategories(c)).includes(category)
        )
          return { applied: false, reason: "invalid_category" };
        await c.query(
          "UPDATE transactions SET ai_category=$2,review_reason=NULL WHERE id=$1",
          [id, category],
        );
        await c.query(
          "INSERT INTO audit_history(mode,transaction_id,action,before_value,after_value) VALUES($1,$2,'llm-classification',$3,$4)",
          [this.mode, id, { category: tx.category }, { category }],
        );
        return { applied: true };
      },
      { client },
    );
  }
  async listReviews() {
    return this.listTransactions({ review: true });
  }
  async resolveReview(id, { action = "keep", pendingId } = {}) {
    if (action === "link") return this.linkPending(id, pendingId);
    if (action !== "keep")
      throw domainError("Review action must be keep or link");
    await this.atomic(async (c) => {
      const row = (
        await c.query(
          "SELECT review_reason FROM transactions WHERE id=$1 AND mode=$2",
          [id, this.mode],
        )
      ).rows[0];
      if (!row) throw domainError("Transaction not found");
      await c.query("UPDATE transactions SET review_reason=NULL WHERE id=$1", [
        id,
      ]);
      await c.query(
        "INSERT INTO audit_history(mode,transaction_id,action,before_value,after_value) VALUES($1,$2,'review-kept',$3,$4)",
        [this.mode, id, row, { reviewReason: null }],
      );
    });
    return this.getTransaction(id);
  }
  async linkPending(postedId, pendingId) {
    if (!pendingId || pendingId === postedId)
      throw domainError("A distinct pending transaction is required");
    await this.atomic(async (c) => {
      const rows = (
        await c.query(
          "SELECT * FROM transactions WHERE mode=$1 AND id=ANY($2::uuid[]) FOR UPDATE",
          [this.mode, [postedId, pendingId]],
        )
      ).rows;
      const posted = rows.find((r) => r.id === postedId),
        pending = rows.find((r) => r.id === pendingId);
      if (
        !posted ||
        !pending ||
        posted.status !== "posted" ||
        pending.status !== "pending" ||
        posted.account_id !== pending.account_id ||
        posted.currency !== pending.currency
      )
        throw domainError(
          "Only a compatible pending and posted pair can be linked",
        );
      // Retain immutable evidence and the retired canonical row; reports exclude the superseded row.
      await c.query(
        "UPDATE source_aliases SET transaction_id=$1 WHERE transaction_id=$2",
        [postedId, pendingId],
      );
      const over = (
        await c.query(
          "SELECT * FROM transaction_overrides WHERE transaction_id=ANY($1::uuid[])",
          [[postedId, pendingId]],
        )
      ).rows;
      if (
        over.some((o) => o.transaction_id === pendingId) &&
        !over.some((o) => o.transaction_id === postedId)
      ) {
        const old = over.find((o) => o.transaction_id === pendingId);
        validateSplits(old.splits, String(posted.amount_minor));
        await c.query(
          "UPDATE transaction_overrides SET transaction_id=$1 WHERE transaction_id=$2",
          [postedId, pendingId],
        );
      }
      await c.query("UPDATE transactions SET review_reason=NULL WHERE id=$1", [
        postedId,
      ]);
      await c.query(
        "UPDATE transactions SET review_reason=NULL,superseded_by=$2 WHERE id=$1",
        [pendingId, postedId],
      );
      await c.query(
        "INSERT INTO audit_history(mode,transaction_id,action,before_value,after_value) VALUES($1,$2,'pending-linked',$3,$4)",
        [this.mode, postedId, { pendingId }, { postedId }],
      );
    });
    return this.getTransaction(postedId);
  }
  async audit(id) {
    return (
      await this.pool.query(
        "SELECT action,before_value,after_value,created_at FROM audit_history WHERE mode=$1 AND transaction_id=$2 ORDER BY id",
        [this.mode, id],
      )
    ).rows;
  }
  async seedDemo() {
    if (this.mode !== "demo")
      throw domainError("Demo seed is forbidden in live mode");
    if (
      (
        await this.pool.query(
          "SELECT 1 FROM transactions WHERE mode=$1 LIMIT 1",
          [this.mode],
        )
      ).rowCount
    )
      return { ok: true, alreadySeeded: true };
    const data = demoData();
    for (const a of data.accounts)
      await this.ingestBatch({
        account: a,
        transactions: data.transactions.filter((t) => t.accountId === a.id),
        coverage: data.coverage,
      });
    for (const b of data.budgets) await this.saveBudget(b);
    for (const r of data.rules) await this.saveRule(r);
    return { ok: true };
  }
}
