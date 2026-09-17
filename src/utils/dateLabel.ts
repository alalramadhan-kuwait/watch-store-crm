/** A single day as a person writes it: "Thu 17 Sep 2026". Display only — the
 *  yyyy-mm-dd string is what every query still uses. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const rangeDayLabel = (ymd: string) => {
  const dow = DAYS[new Date(`${ymd}T12:00:00+03:00`).getUTCDay()];
  return `${dow} ${Number(ymd.slice(8))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
};
