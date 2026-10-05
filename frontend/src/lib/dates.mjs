// Stamps read in the household's own zone, the one the footer names, with month names: 3 Oct 2026, 04:54 pm.
const formats = new Map();
let zone;

export function setStampTimeZone(value) {
  zone = value || undefined;
}

function formatter() {
  const key = zone || '';
  if (!formats.has(key)) {
    const options = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    try {
      formats.set(key, new Intl.DateTimeFormat('en-AU', { ...options, timeZone: zone }));
    } catch {
      formats.set(key, new Intl.DateTimeFormat('en-AU', { ...options, timeZone: 'Australia/Brisbane' }));
    }
  }

  return formats.get(key);
}

export function formatStamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : formatter().format(date);
}
