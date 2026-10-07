import { addDaysYmd, DAY_NAMES, zonedDate } from '../../utils/time.js';

// Which weekdays (Mon=0) get a photo, for 1–7 photos a week
const PHOTO_DAYS = {
  1: [2],
  2: [1, 4],
  3: [0, 2, 4],
  4: [0, 2, 4, 5],
  5: [0, 1, 3, 4, 5],
  6: [0, 1, 2, 3, 4, 5],
  7: [0, 1, 2, 3, 4, 5, 6],
};
// Slightly different time each day so uploads look natural
const PHOTO_TIMES = ['10:30', '12:15', '15:40', '11:20', '16:10', '13:05', '17:20'];

/** Photo posting slots in the week starting on weekStart (a Monday, YYYY-MM-DD). */
export function photoSlots(weekStart, perWeek, tz) {
  const days = PHOTO_DAYS[Math.max(0, Math.min(7, perWeek))] || [];
  return days.map((d) => {
    const ymd = addDaysYmd(weekStart, d);
    return { ymd, at: zonedDate(ymd, PHOTO_TIMES[d], tz) };
  });
}

/** Post slots: the chosen day, then spread through the week for 2–3 posts. */
export function postSlots(weekStart, { perWeek = 1, day = 'tuesday', time = '11:00' }, tz) {
  const first = Math.max(0, DAY_NAMES.indexOf(day));
  const offsets = { 1: [0], 2: [0, 3], 3: [0, 2, 4] }[Math.max(0, Math.min(3, perWeek))] || [];
  return offsets
    .map((o, i) => {
      const d = (first + o) % 7;
      const ymd = addDaysYmd(weekStart, d);
      return { ymd, at: zonedDate(ymd, /^\d{2}:\d{2}$/.test(time) ? time : '11:00', tz), key: `${weekStart}:${i}` };
    })
    .sort((a, b) => a.at - b.at);
}
