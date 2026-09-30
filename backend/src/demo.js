/** Fictional, explicitly demo-only records. Never mixed with a live Store. */
export function demoData(now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const previous = new Date(`${month}-01T00:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const last = previous.toISOString().slice(0, 7);
  const fetchedAt = now.toISOString();
  const accounts = [
    {
      id: "demo-everyday",
      name: "Everyday · Fictional Bank",
      currency: "AUD",
      balanceMinor: "843275",
      balanceType: "available",
      balanceAt: fetchedAt,
    },
    {
      id: "demo-savings",
      name: "Rainy day · Fictional Bank",
      currency: "AUD",
      balanceMinor: "1840000",
      balanceType: "current",
      balanceAt: fetchedAt,
    },
    {
      id: "demo-card",
      name: "Everyday card · Fictional Bank",
      currency: "AUD",
      balanceMinor: "-67240",
      balanceType: "current",
      balanceAt: fetchedAt,
    },
  ];
  const transactions = [];
  function t(
    id,
    day,
    description,
    amount,
    category,
    kind,
    accountId = "demo-everyday",
    status = "posted",
    m = month,
  ) {
    transactions.push({
      mode: "demo",
      provider: "demo",
      sourceId: `${m}-${id}`,
      accountId,
      currency: "AUD",
      amountMinor: String(amount),
      status,
      date: `${m}-${String(day).padStart(2, "0")}`,
      description,
      category,
      kind,
      fetchedAt,
      raw: { fictional: true },
    });
  }
  t("salary", 1, "Northstar Studio · Salary", 620000, "Income", "income");
  t("rent", 2, "Riverbend apartment · Rent", -210000, "Housing", "expense");
  t("savings-out", 3, "Transfer to rainy day", -80000, "Transfers", "transfer");
  t(
    "savings-in",
    3,
    "Transfer from everyday",
    80000,
    "Transfers",
    "transfer",
    "demo-savings",
  );
  t("groceries-1", 4, "Green Basket Market", -12865, "Groceries", "expense");
  t("coffee-1", 5, "Corner Coffee", -650, "Dining", "expense");
  t("coffee-2", 5, "Corner Coffee", -650, "Dining", "expense");
  t("internet", 6, "Brightwave Internet", -7900, "Utilities", "expense");
  t("train", 7, "City transit top-up", -5000, "Transport", "expense");
  t("dinner", 8, "Paper Lantern Kitchen", -8640, "Dining", "expense");
  t("groceries-2", 10, "Green Basket Market", -15420, "Groceries", "expense");
  t(
    "streaming",
    11,
    "Cloud Cinema subscription",
    -1899,
    "Entertainment",
    "expense",
  );
  t("pharmacy", 12, "Riverbend Pharmacy", -4280, "Health", "expense");
  t(
    "clothes",
    14,
    "Linen & Thread",
    -18900,
    "Shopping",
    "expense",
    "demo-card",
  );
  t("power", 15, "Solar Coast Energy", -14670, "Utilities", "expense");
  t(
    "refund",
    16,
    "Linen & Thread · Return",
    5900,
    "Shopping",
    "refund",
    "demo-card",
  );
  t(
    "repayment-out",
    17,
    "Credit card repayment",
    -30000,
    "Transfers",
    "transfer",
  );
  t(
    "repayment-in",
    17,
    "Repayment received",
    30000,
    "Transfers",
    "transfer",
    "demo-card",
  );
  t("groceries-3", 18, "Green Basket Market", -11280, "Groceries", "expense");
  t("cinema", 19, "Riverside Cinema", -4400, "Entertainment", "expense");
  t("lunch", 20, "Little Orchard Cafe", -3250, "Dining", "expense");
  t("unknown", 21, "SQ * WEEKEND STALL", -3750, null, "expense");
  t("groceries-4", 22, "Green Basket Market", -16980, "Groceries", "expense");
  t("fuel", 23, "Coastal Fuel", -7840, "Transport", "expense");
  t("dinner-2", 24, "Paper Lantern Kitchen", -12400, "Dining", "expense");
  t("freelance", 25, "Oak Design · Invoice 104", 45000, "Income", "income");
  t(
    "pending",
    26,
    "Harbour Books · Pending",
    -4295,
    "Shopping",
    "expense",
    "demo-card",
    "pending",
  );
  t(
    "last-entertainment",
    13,
    "Riverside Cinema",
    -4500,
    "Entertainment",
    "expense",
    "demo-everyday",
    "posted",
    last,
  );
  const budgets = [
    ["Groceries", "55000", false],
    ["Dining", "24000", false],
    ["Shopping", "25000", false],
    ["Transport", "20000", false],
    ["Entertainment", "10000", true],
    ["Utilities", "25000", false],
  ].map(([category, capMinor, rollover]) => ({
    category,
    capMinor,
    currency: "AUD",
    month,
    rollover,
  }));
  budgets.unshift({
    category: "Entertainment",
    capMinor: "10000",
    currency: "AUD",
    month: last,
    rollover: true,
  });
  return {
    accounts,
    transactions,
    budgets,
    rules: [
      { contains: "Green Basket", category: "Groceries", priority: 10 },
      {
        contains: "repayment",
        category: "Transfers",
        kind: "transfer",
        priority: 20,
      },
    ],
    coverage: {
      from: `${last}-01`,
      to: `${month}-28`,
      truncated: false,
      reason:
        "Fictional demonstration windows; balances are independent snapshots.",
    },
  };
}
