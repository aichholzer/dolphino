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

// A calendar day such as 2026-10-06 reads 6 Oct 2026; it names no instant, so no zone shifts it.
const dayFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC'
});
export function formatDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  // Date rolls 2026-02-30 over to 2 March. Anything but a real calendar day prints as given.
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? String(value)
    : dayFormat.format(date);
}
