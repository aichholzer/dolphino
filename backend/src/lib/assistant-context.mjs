const DAY = 86400000;
export const DATE_PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_n_days',
  'last_n_weeks',
  'previous_n_months',
  'custom'
];

const shift = (date, days) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
const formatter = (timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const invalid = (message) => {
  throw Object.assign(Error(message), { status: 400, expose: true });
};

const validDate = (date) =>
  typeof date === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date;

// Server-owned calendar context, independent of the model's training date and host timezone.
export function assistantCalendar(now, timeZone) {
  const asOf = new Date(now).toISOString();
  const today = formatter(timeZone).format(new Date(now));
  const currentStart = `${today.slice(0, 7)}-01`;
  const previousEnd = shift(currentStart, -1);
  const monday = shift(today, -((new Date(today).getUTCDay() + 6) % 7));
  return {
    asOf,
    timeZone,
    today,
    lastMonth: { from: `${previousEnd.slice(0, 7)}-01`, to: previousEnd },
    thisMonth: { from: currentStart, to: today },
    yesterday: { from: shift(today, -1), to: shift(today, -1) },
    thisWeek: { from: monday, to: today },
    lastWeek: { from: shift(monday, -7), to: shift(monday, -1) }
  };
}

// Find the first instant whose local calendar date is at least the requested date.
// Calendar arithmetic above uses date labels; these explanatory UTC bounds account
// for short/long DST days and zones whose offset changes at local midnight.
function dayStart(date, timeZone) {
  const format = formatter(timeZone);
  let low = Date.parse(date) / 1000 - (2 * DAY) / 1000;
  let high = Date.parse(date) / 1000 + (2 * DAY) / 1000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (format.format(new Date(middle * 1000)) < date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return new Date(low * 1000).toISOString();
}

export function resolveAssistantDates(input, now, timeZone) {
  const calendar = assistantCalendar(now, timeZone);
  const { period, count = null } = input;
  const numbered = ['last_n_days', 'last_n_weeks', 'previous_n_months'].includes(period);
  if (
    !DATE_PERIODS.includes(period) ||
    (numbered ? !Number.isInteger(count) || count < 1 || count > 366 : count !== null)
  ) {
    invalid('Choose a supported calendar period and a positive count only for numbered periods.');
  }

  if (period !== 'custom' && (input.from != null || input.to != null)) {
    invalid('Use custom for explicit dates; do not combine explicit and relative ranges.');
  }

  const known = {
    today: { from: calendar.today, to: calendar.today },
    yesterday: calendar.yesterday,
    this_week: calendar.thisWeek,
    last_week: calendar.lastWeek,
    this_month: calendar.thisMonth,
    last_month: calendar.lastMonth
  };
  let range = known[period];
  if (period === 'custom') {
    range = { from: input.from, to: input.to };
  } else if (period === 'last_n_days' || period === 'last_n_weeks') {
    range = { from: shift(calendar.today, -(count * (period === 'last_n_weeks' ? 7 : 1) - 1)), to: calendar.today };
  } else if (period === 'previous_n_months') {
    const [year, month] = calendar.today.split('-').map(Number);
    range = {
      from: new Date(Date.UTC(year, month - 1 - count, 1)).toISOString().slice(0, 10),
      to: calendar.lastMonth.to
    };
  }

  if (!validDate(range?.from) || !validDate(range?.to)) {
    invalid('Use valid inclusive calendar dates in YYYY-MM-DD form.');
  }

  const days = (Date.parse(range.to) - Date.parse(range.from)) / DAY + 1;
  if (days < 1 || days > 366) {
    invalid('Choose a date range of 1 to 366 days.');
  }

  return {
    ...range,
    asOf: calendar.asOf,
    today: calendar.today,
    timeZone,
    period,
    count,
    days,
    includesToday: range.from <= calendar.today && range.to >= calendar.today,
    semantics:
      period === 'last_n_weeks' || period === 'last_n_days'
        ? 'Rolling calendar days including today; today is partial.'
        : period === 'last_week'
          ? 'Previous complete Monday–Sunday calendar week.'
          : period === 'previous_n_months' || period === 'last_month'
            ? 'Previous complete calendar month(s).'
            : 'Inclusive local ledger dates; any current day is partial.',
    utcFrom: dayStart(range.from, timeZone),
    utcToExclusive: dayStart(shift(range.to, 1), timeZone),
    timestampPolicy:
      'UTC interval is start-inclusive/end-exclusive. Ledger dates remain local YYYY-MM-DD labels and are not converted to timestamps.'
  };
}
