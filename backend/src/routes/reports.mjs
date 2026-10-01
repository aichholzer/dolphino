export function registerReportRoutes({ route, ledger, filters, report, config }) {
  route('get', '/api/dashboard', report, { access: 'financial' });

  route(
    'get',
    '/api/export',
    async (req, res) => {
      const f = filters(req);
      const snapshot = await ledger(req).exportSnapshot(f);
      res.setHeader('Content-Disposition', 'attachment; filename="dolphino-export.json"');
      return {
        exportedAt: new Date().toISOString(),
        mode: config.mode,
        ...snapshot
      };
    },
    { access: 'financial' }
  );
}
