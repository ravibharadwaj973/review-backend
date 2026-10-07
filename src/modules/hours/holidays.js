/**
 * Public holidays in India (Central Government gazetted list, plus a few widely observed
 * festivals). Dates of some festivals vary by state — owners can change any date.
 * Sources: DoPT holiday orders for 2026 and 2027.
 */
export const HOLIDAYS = [
  // 2026
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-26', name: 'Republic Day' },
  { date: '2026-03-04', name: 'Holi' },
  { date: '2026-03-21', name: 'Id-ul-Fitr' },
  { date: '2026-03-26', name: 'Ram Navami' },
  { date: '2026-03-31', name: 'Mahavir Jayanti' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-05-01', name: 'Buddha Purnima' },
  { date: '2026-05-27', name: 'Id-ul-Zuha (Bakrid)' },
  { date: '2026-06-26', name: 'Muharram' },
  { date: '2026-08-15', name: 'Independence Day' },
  { date: '2026-08-26', name: 'Milad-un-Nabi' },
  { date: '2026-08-28', name: 'Raksha Bandhan' },
  { date: '2026-09-04', name: 'Janmashtami' },
  { date: '2026-09-14', name: 'Ganesh Chaturthi' },
  { date: '2026-10-02', name: 'Gandhi Jayanti' },
  { date: '2026-10-20', name: 'Dussehra' },
  { date: '2026-11-08', name: 'Diwali' },
  { date: '2026-11-11', name: 'Bhai Dooj' },
  { date: '2026-11-15', name: 'Chhath Puja' },
  { date: '2026-11-24', name: "Guru Nanak's Birthday" },
  { date: '2026-12-25', name: 'Christmas' },
  { date: '2026-12-31', name: "New Year's Eve" },
  // 2027
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-26', name: 'Republic Day' },
  { date: '2027-03-10', name: 'Id-ul-Fitr' },
  { date: '2027-03-23', name: 'Holi' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-04-15', name: 'Ram Navami' },
  { date: '2027-04-19', name: 'Mahavir Jayanti' },
  { date: '2027-05-17', name: 'Id-ul-Zuha (Bakrid)' },
  { date: '2027-05-20', name: 'Buddha Purnima' },
  { date: '2027-06-16', name: 'Muharram' },
  { date: '2027-08-15', name: 'Independence Day' },
  { date: '2027-08-25', name: 'Janmashtami' },
  { date: '2027-10-02', name: 'Gandhi Jayanti' },
  { date: '2027-10-09', name: 'Dussehra' },
  { date: '2027-10-29', name: 'Diwali' },
  { date: '2027-11-14', name: "Guru Nanak's Birthday" },
  { date: '2027-12-25', name: 'Christmas' },
  { date: '2027-12-31', name: "New Year's Eve" },
];

/** Holidays from `fromYmd` for the next `days` days. */
export function upcomingHolidays(fromYmd, days = 120) {
  const end = new Date(`${fromYmd}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + days);
  const endYmd = end.toISOString().slice(0, 10);
  return HOLIDAYS.filter((h) => h.date >= fromYmd && h.date <= endYmd);
}
