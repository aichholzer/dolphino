import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateReport,
  validateSplits,
  minor,
  classify,
} from "../src/engine.js";
const tx = (id, amountMinor, extra = {}) => ({
  id,
  amountMinor,
  currency: "AUD",
  status: "posted",
  date: "2026-09-15",
  category: "Groceries",
  kind: "expense",
  description: "Shop",
  ...extra,
});
test("integer minor arithmetic preserves values above Number safe range", () => {
  assert.equal(
    calculateReport([tx("a", "-9007199254740993"), tx("b", "-1")], [], {
      month: "2026-09",
    }).expensesMinor,
    "9007199254740994",
  );
  assert.throws(() => minor(1));
  assert.throws(() => minor("0.01"));
});
test("actuals include identical purchases and uncategorized, exclude transfers and pending, net refunds", () => {
  const r = calculateReport(
    [
      tx("a", "-1000"),
      tx("b", "-1000"),
      tx("refund", "500", { kind: "refund" }),
      tx("transfer", "-100000", { kind: "transfer" }),
      tx("repayment", "100000", { kind: "transfer" }),
      tx("pending", "-300", { status: "pending" }),
      tx("unknown", "-200", { category: null }),
      tx("salary", "5000", { kind: "income" }),
    ],
    [],
    { month: "2026-09" },
  );
  assert.equal(r.expensesMinor, "1700");
  assert.equal(r.incomeMinor, "5000");
  assert.equal(r.netMinor, "3300");
  assert.equal(r.pendingMinor, "-300");
  assert.equal(
    r.categories.find((x) => x.category === "Uncategorized").spentMinor,
    "200",
  );
  assert.deepEqual(r.transactionIds.expenses, ["a", "b", "refund", "unknown"]);
});
test("splits exact and categories share one total", () => {
  const splits = [
    { category: "Groceries", amountMinor: "-333" },
    { category: "Health", amountMinor: "-667" },
  ];
  validateSplits(splits, "-1000");
  assert.throws(() => validateSplits(splits, "-1001"));
  assert.throws(() =>
    validateSplits(
      [
        { category: "A", amountMinor: "100" },
        { category: "B", amountMinor: "-1100" },
      ],
      "-1000",
    ),
  );
  const r = calculateReport([tx("a", "-1000", { splits })], [], {
    month: "2026-09",
  });
  assert.equal(r.expensesMinor, "1000");
  assert.equal(
    r.categories.find((c) => c.category === "Health").spentMinor,
    "667",
  );
});
test("positive rollover recalculates from history, negatives reset and allocations are not expenses", () => {
  const budgets = ["2026-08", "2026-09", "2026-10"].map((month) => ({
    category: "Groceries",
    currency: "AUD",
    month,
    capMinor: "1000",
    allocationMinor: "100",
    rollover: true,
  }));
  let transactions = [
    tx("aug", "-500", { date: "2026-08-31" }),
    tx("sep", "-2000", { date: "2026-09-01" }),
  ];
  assert.equal(
    calculateReport(transactions, budgets, { month: "2026-09" }).budgets[0]
      .carryMinor,
    "600",
  );
  assert.equal(
    calculateReport(transactions, budgets, { month: "2026-10" }).budgets[0]
      .carryMinor,
    "0",
  );
  transactions.push(tx("late", "-300", { date: "2026-08-15" }));
  assert.equal(
    calculateReport(transactions, budgets, { month: "2026-09" }).budgets[0]
      .carryMinor,
    "300",
  );
  assert.equal(
    calculateReport(transactions, budgets, { month: "2026-10" }).expensesMinor,
    "0",
  );
});
test("refund uses its posted month and explicit currency", () => {
  const r = calculateReport(
    [
      tx("purchase", "-1000", { date: "2026-08-31" }),
      tx("return", "1000", { kind: "refund", date: "2026-09-01" }),
      tx("other", "-99999", { currency: "USD" }),
    ],
    [],
    { month: "2026-09", currency: "AUD" },
  );
  assert.equal(r.expensesMinor, "-1000");
});
test("rule first preserves provider category fallback", () => {
  assert.equal(classify(tx("a", "-1", { category: "Food" })).category, "Food");
  assert.equal(
    classify(tx("a", "-1"), [
      { id: "1", contains: "shop", category: "Shopping", priority: 1 },
    ]).category,
    "Shopping",
  );
});
