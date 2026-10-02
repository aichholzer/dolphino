import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantCalendar } from '../src/lib/assistant-context.mjs';
import { assistantSpendingFixture, spendingQuestion, aggregateQuery } from './helpers/assistant-spending-fixture.mjs';
import { readTestPostgresConfig } from './helpers/postgres.mjs';

test('assistant household calendar resolves previous calendar month across UTC boundaries, leap years and year rollover', () => {
  assert.deepEqual(assistantCalendar('2026-10-01T00:30:00Z', 'America/Los_Angeles').lastMonth, {
    from: '2026-08-01',
    to: '2026-08-31'
  });
  assert.deepEqual(assistantCalendar('2026-10-01T00:30:00Z', 'Australia/Brisbane').lastMonth, {
    from: '2026-09-01',
    to: '2026-09-30'
  });
  assert.deepEqual(assistantCalendar('2024-03-31T12:00:00Z', 'Etc/UTC').lastMonth, {
    from: '2024-02-01',
    to: '2024-02-29'
  });
  assert.deepEqual(assistantCalendar('2026-12-31T12:00:00Z', 'Pacific/Kiritimati').lastMonth, {
    from: '2026-12-01',
    to: '2026-12-31'
  });
});

for (const provider of ['openai', 'bedrock']) {
  test(
    `${provider}: generic categories, explicit dates, comparisons and income share the same bounded orchestration`,
    { skip: !readTestPostgresConfig() },
    async () => {
      const f = await assistantSpendingFixture(provider);
      try {
        for (const example of [
          {
            question: 'How much did I spend on Groceries in September 2026?',
            args: { ...aggregateQuery, category: 'Groceries', from: '2026-09-01', to: '2026-09-30' },
            metric: 'expensesMinor',
            total: '10000'
          },
          {
            question: 'Compare Work spending in August 2026 with the preceding period.',
            args: { ...aggregateQuery, category: 'Work', comparePrevious: true },
            metric: 'expensesMinor',
            total: '500',
            comparison: '500'
          },
          {
            question: 'What income arrived during August 2026?',
            args: { ...aggregateQuery, category: null, kind: 'income', groupBy: 'month' },
            metric: 'incomeMinor',
            total: '500'
          },
          ...[
            ['What did I spend eating out yesterday?', 'yesterday', null, '200', ['2026-09-29', '2026-09-29']],
            ['Summarise dining out the previous week.', 'last_week', null, '400', ['2026-09-21', '2026-09-27']],
            ['What did restaurants cost the previous month?', 'last_month', null, '2300', ['2026-08-01', '2026-08-31']],
            [
              'Summarise dining out over the last 3 weeks, rolling through today.',
              'last_n_weeks',
              3,
              '1200',
              ['2026-09-10', '2026-09-30']
            ]
          ].map(([question, period, count, total, dates]) => ({
            question,
            args: {
              ...aggregateQuery,
              category: 'Eating out',
              from: null,
              to: null,
              dateRange: { period, count, from: null, to: null }
            },
            metric: 'expensesMinor',
            total,
            dates,
            resolveFirst: period === 'last_n_weeks'
          }))
        ]) {
          f.scenario('generic', example);
          const response = await f.ask(example.question);
          assert.equal(response.status, 200, await response.clone().text());
          assert.match((await response.json()).reply, new RegExp(example.total));
          assert.equal(f.calls.length, example.resolveFirst ? 3 : 2);
          assert.equal(f.executed.length, example.resolveFirst ? 2 : 1);
          const result = f.calls
            .at(-1)
            .messages.filter((entry) => entry.role === 'tool')
            .map((entry) => JSON.parse(entry.content))
            .at(-1);
          if (example.dates) {
            assert.equal(result.provenance.dateRange.timeZone, 'America/Los_Angeles');
            assert.match(result.provenance.dateRange.utcFrom, /Z$/);
          }
        }
      } finally {
        await f.close();
      }
    }
  );

  test(
    `${provider}: exact typo spending question completes category lookup, scoped aggregate and answer within three rounds over PostgreSQL/HTTP`,
    { skip: !readTestPostgresConfig() },
    async () => {
      const f = await assistantSpendingFixture(provider);
      try {
        const before = (await f.pool.query('SELECT id,payload FROM provider_observations ORDER BY id')).rows;
        const response = await f.ask(spendingQuestion);
        assert.equal(response.status, 200, await response.clone().text());
        const result = await response.json();
        assert.match(result.reply, /AUD 23\.00/);
        assert.match(result.reply, /1–31 August 2026/);
        assert.equal(f.calls.length, 3);
        assert.deepEqual(
          f.executed.map((call) => call.name),
          ['finance_categories', 'finance_aggregate']
        );
        assert.equal(f.calls[2].finalAnswer, true);
        assert.match(f.calls[2].system, /final answer round/);
        const source = result.citations.find((c) => c.tool === 'finance_aggregate');
        const report = await f.json('viewer', `/api/assistant/reports/${source.reportId}`);
        assert.equal(report.data.totals.expensesMinor, '2300');
        assert.equal(report.data.totals.pendingMinor, '-99');
        assert.equal(report.data.totals.refundCount, 1);
        assert.equal(report.data.category.name, 'Eating out');
        assert.ok(!JSON.stringify(result).includes('Hidden merchant'));
        assert.ok(!JSON.stringify(result).includes('Secret category'));
        await f.json('admin', '/api/settings/categories', 'PATCH', { category: 'Dining', name: 'Meals away' });
        await f.json('admin', '/api/settings/categories', 'DELETE', { category: 'Dining' });
        const historical = await f.json('viewer', `/api/assistant/reports/${source.reportId}`);
        assert.equal(historical.data.totals.expensesMinor, '2300');
        assert.deepEqual(historical.data.category, { category: 'Dining', name: 'Meals away', archived: true });
        assert.deepEqual((await f.pool.query('SELECT id,payload FROM provider_observations ORDER BY id')).rows, before);
        assert.equal((await f.store.getTransaction(f.corrected.id)).category, 'Dining');
        assert.equal((await f.http('admin', `/api/assistant/reports/${source.reportId}`)).status, 404);
        await f.grant('viewer', {});
        assert.equal((await f.http('viewer', `/api/assistant/reports/${source.reportId}`)).status, 403);
        assert.deepEqual(f.diagnostics, []);
      } finally {
        await f.close();
      }
    }
  );

  test(
    `${provider}: direct synonym aggregate completes in two calls and preserves native reasoning/tool replay`,
    { skip: !readTestPostgresConfig() },
    async () => {
      const f = await assistantSpendingFixture(provider);
      try {
        for (const wording of [
          'How much did I spend dining out last month?',
          'How much did restaurants cost last month?',
          spendingQuestion
        ]) {
          f.scenario('direct');
          const response = await f.ask(wording);
          assert.equal(response.status, 200, await response.clone().text());
          assert.match((await response.json()).reply, /AUD 23\.00/);
          assert.equal(f.calls.length, 2);
          assert.equal(f.executed.length, 1);
          const native = f.calls[1].messages.filter((entry) => entry.provider);
          assert.equal(native[0].provider, provider);
          assert.ok(JSON.stringify(native).includes(provider === 'openai' ? 'opaque-test-state' : 'test-signature'));
        }
      } finally {
        await f.close();
      }
    }
  );

  test(
    `${provider}: provider failure, unknown category and repeated tool loop remain recoverable, redacted and bounded`,
    { skip: !readTestPostgresConfig() },
    async () => {
      const f = await assistantSpendingFixture(provider);
      try {
        f.scenario('unknown');
        let response = await f.ask();
        assert.equal(response.status, 200);
        let result = await response.json();
        assert.match(result.reply, /no spending total was calculated/);
        assert.ok(!result.reply.includes('0.00'));
        assert.deepEqual(result.citations, []);
        f.scenario('repeat');
        response = await f.ask();
        assert.equal(response.status, 409);
        assert.match((await response.json()).error, /instead of finishing.*Reference:/);
        assert.equal(f.calls.length, 3);
        assert.equal(f.executed.length, 2, 'final round never executes an unanswerable extra query');
        f.scenario('provider-failure');
        response = await f.ask();
        assert.equal(response.status, 502);
        result = await response.json();
        assert.match(result.error, /provider unavailable.*Reference:/);
        const diagnostics = JSON.stringify(f.diagnostics);
        for (const secret of [
          'synthetic-never-send',
          'PRIVATE',
          'Hidden merchant',
          'Eating out',
          '23.00',
          spendingQuestion
        ]) {
          assert.ok(!diagnostics.includes(secret));
          assert.ok(!result.error.includes(secret));
        }

        assert.deepEqual(
          Object.keys(f.diagnostics.at(-1)).sort(),
          ['event', 'lastTool', 'provider', 'phase', 'requestId', 'rounds', 'toolCalls'].sort()
        );
        f.scenario('direct');
        response = await f.ask();
        assert.equal(response.status, 200, 'retry can succeed after recoverable failure');
      } finally {
        await f.close();
      }
    }
  );
}

test(
  'category tools distinguish aliases, display names, stable keys, ambiguity and opaque IDs without crossing grants',
  { skip: !readTestPostgresConfig() },
  async () => {
    const f = await assistantSpendingFixture();
    try {
      for (const category of ['Dining', 'Eating out', 'eating-out', 'dining out', 'restaurants']) {
        const result = await f.json('viewer', '/api/assistant/tools/finance_aggregate', 'POST', {
          ...aggregateQuery,
          category
        });
        assert.equal(result.data.totals.expensesMinor, '2300');
        assert.equal(result.provenance.filters.category, 'Dining');
      }

      for (const category of ['cat_opaque', 'Secret category', 'missing']) {
        const result = await f.json('viewer', '/api/assistant/tools/finance_aggregate', 'POST', {
          ...aggregateQuery,
          category
        });
        assert.equal(result.error.code, 'category_not_found');
        assert.equal(result.data, undefined);
        const lookup = await f.json('viewer', '/api/assistant/tools/finance_categories', 'POST', {
          currency: 'AUD',
          query: category
        });
        assert.equal(lookup.error.code, 'category_not_found');
        assert.equal(lookup.data, undefined);
      }

      const catalog = await f.json('viewer', '/api/assistant/tools/finance_categories', 'POST', {
        currency: 'AUD',
        query: null
      });
      assert.ok(!JSON.stringify(catalog).includes('Secret category'));
      assert.ok(!JSON.stringify(catalog).includes('cat_opaque'));
      const grouped = await f.json('viewer', '/api/assistant/tools/finance_aggregate', 'POST', {
        ...aggregateQuery,
        groupBy: 'category'
      });
      assert.equal(grouped.data.groups[0].categoryDisplayLabel, 'Eating out');
      await f.json('admin', '/api/settings/categories', 'POST', { name: 'Restaurants' });
      const ambiguous = await f.json('viewer', '/api/assistant/tools/finance_aggregate', 'POST', {
        ...aggregateQuery,
        category: 'dining out'
      });
      assert.equal(ambiguous.error.code, 'category_ambiguous');
      assert.equal(ambiguous.categories.length, 2);
      for (const user of ['none', 'anonymous']) {
        assert.equal(
          (await f.http(user, '/api/assistant/tools/finance_categories', 'POST', { currency: 'AUD', query: null }))
            .status,
          user === 'none' ? 403 : 401
        );
      }

      assert.equal(
        (
          await f.http(
            'viewer',
            '/api/assistant/tools/finance_categories',
            'POST',
            { currency: 'AUD', query: null },
            'https://hostile.invalid'
          )
        ).status,
        403
      );
      assert.equal(
        (
          await f.http('viewer', '/api/assistant/tools/finance_aggregate', 'POST', {
            ...aggregateQuery,
            accountId: 'hidden'
          })
        ).status,
        404
      );
    } finally {
      await f.close();
    }
  }
);
