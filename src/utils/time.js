/**
 * Wall-clock helpers. Schedules are planned in the business's own timezone
 * (default Asia/Kolkata) while the server runs in UTC.
 */

const partsCache = new Map();
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
      })
    );
  }
  return partsCache.get(tz);
}

function parts(date, tz) {
  return Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
}

const WEEKDAY = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
export const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function safeTz(tz) {
  try {
    formatter(tz || 'Asia/Kolkata');
    return tz || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

/** Minutes the timezone is ahead of UTC at that moment. */
export function tzOffsetMinutes(tz, date = new Date()) {
  const p = parts(date, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** "2026-10-07" + "11:30" in tz → Date */
export function zonedDate(ymd, hhmm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = String(hhmm || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = tzOffsetMinutes(tz, new Date(guess));
  return new Date(guess - off * 60000);
}

/** Date → "YYYY-MM-DD" in tz */
export function localYmd(date, tz) {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Monday = 0 … Sunday = 6, in tz */
export function localWeekday(date, tz) {
  return WEEKDAY[parts(date, tz).weekday];
}

export function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Monday of the week containing date, as YYYY-MM-DD in tz */
export function weekStartYmd(date, tz) {
  return addDaysYmd(localYmd(date, tz), -localWeekday(date, tz));
}

export const ymdToParts = (ymd) => {
  const [year, month, day] = ymd.split('-').map(Number);
  return { year, month, day };
};
