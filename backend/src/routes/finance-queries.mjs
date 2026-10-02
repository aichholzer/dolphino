export function createFinanceQueries({ config }) {
  const ledger = (req) => {
    if (!req.accessStore) {
      throw new Error('Financial route requires a request-scoped access store');
    }

    return req.accessStore;
  };

  const filters = (req) => {
    const q = { ...req.query };
    if (!q.month && q.ids === undefined && q.allHistory !== 'true' && !q.from && !q.to) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timezone,
        year: 'numeric',
        month: '2-digit'
      }).formatToParts(new Date());
      q.month = `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
    }

    if (q.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) {
      throw Object.assign(Error('Invalid month'), { status: 400 });
    }

    if (q.currency && !/^[A-Z]{3}$/.test(q.currency)) {
      throw Object.assign(Error('Invalid currency'), { status: 400 });
    }

    if (q.months && ![1, 2, 3, 4, 5, 6].includes(Number(q.months))) {
      throw Object.assign(Error('Invalid overview period'), { status: 400 });
    }

    for (const field of ['from', 'to']) {
      if (
        q[field] &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(q[field]) ||
          !Number.isFinite(Date.parse(q[field])) ||
          new Date(q[field]).toISOString().slice(0, 10) !== q[field])
      ) {
        throw Object.assign(Error('Invalid date'), { status: 400 });
      }
    }

    if (q.from && q.to && q.from > q.to) {
      throw Object.assign(Error('Invalid date range'), { status: 400 });
    }

    return {
      ...q,
      months: Number(q.months || 1),
      currency: q.currency || config.currency
    };
  };

  const report = async (req) => {
    if (req.query.allHistory || req.query.from || req.query.to) {
      throw Object.assign(Error('Overview uses a month and period'), {
        status: 400
      });
    }

    const r = await ledger(req).report(filters(req));
    return {
      ...r,
      trend: r.daily?.map((d) => ({ ...d, label: d.date })),
      categories: r.categories?.map((c) => ({
        ...c,
        amountMinor: c.spentMinor
      }))
    };
  };

  return { ledger, filters, report };
}
