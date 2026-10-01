export function createSecurityHeaders(config) {
  return function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.mode === 'live') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
  };
}

// One limiter belongs to each app instance; demo cannot store credentials or call providers.
export function createSensitiveActionGuard(config) {
  const sensitiveCalls = new Map();
  return function sensitive(action) {
    if (config.mode !== 'live') {
      throw Object.assign(Error('Credential settings and external actions require authenticated live mode'), {
        status: 409
      });
    }
    const now = Date.now();
    const prior = sensitiveCalls.get(action) || [];
    const recent = prior.filter((t) => now - t < 60000);
    if (recent.length >= 5) {
      throw Object.assign(Error('Too many settings requests; retry in one minute'), { status: 429 });
    }
    recent.push(now);
    sensitiveCalls.set(action, recent);
  };
}
