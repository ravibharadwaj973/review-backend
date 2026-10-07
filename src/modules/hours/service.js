import { localYmd, safeTz, ymdToParts, addDaysYmd } from '../../utils/time.js';
import { upcomingHolidays } from './holidays.js';

const DAY_ENUM = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

const plain = (v) => (v?.toObject ? v.toObject() : v);

/** The season (if any) that covers a given date. */
export function activeSeason(business, date = new Date()) {
  const today = localYmd(date, safeTz(business.timezone));
  return (business.seasonalHours || []).map(plain).find((s) => s.start <= today && today <= s.end && s.hours?.length === 7) || null;
}

/** Weekly hours in force today: a season's hours when one is active, otherwise the regular hours. */
export function effectiveHours(business, date = new Date()) {
  const season = activeSeason(business, date);
  return (season ? season.hours : (business.hours || []).map(plain)).map((h) => ({ day: h.day, open: h.open, close: h.close, closed: !!h.closed }));
}

export const hoursSignature = (hours) => hours.map((h) => (h.closed ? `${h.day}:x` : `${h.day}:${h.open}-${h.close}`)).join('|');

const toTime = (hhmm) => {
  const [hours, minutes] = String(hhmm || '00:00').split(':').map(Number);
  return { hours, minutes };
};

/** Special hours for today onwards, in Google's format. Past dates are left out. */
export function specialHoursToGoogle(business, date = new Date()) {
  const today = localYmd(date, safeTz(business.timezone));
  const periods = (business.specialHours || [])
    .map(plain)
    .filter((s) => s.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => {
      const d = ymdToParts(s.date);
      if (s.closed || !s.open || !s.close) return { startDate: d, endDate: d, closed: true };
      // A closing time after midnight ends on the next day
      const endDate = s.close <= s.open ? ymdToParts(addDaysYmd(s.date, 1)) : d;
      return { startDate: d, openTime: toTime(s.open), endDate, closeTime: toTime(s.close), closed: false };
    });
  return { specialHourPeriods: periods };
}

export { DAY_ENUM };

/** Upcoming holidays with whether the business has already set hours for them. */
export function holidayPlan(business, { days = 120, date = new Date() } = {}) {
  const today = localYmd(date, safeTz(business.timezone));
  const set = new Map((business.specialHours || []).map(plain).map((s) => [s.date, s]));
  return upcomingHolidays(today, days).map((h) => {
    const special = set.get(h.date);
    const daysAway = Math.round((Date.parse(`${h.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
    return { ...h, daysAway, set: Boolean(special), special: special || null };
  });
}
