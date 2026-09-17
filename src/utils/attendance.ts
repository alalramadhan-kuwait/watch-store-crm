/**
 * Attendance and leave rules, shared with Timekeeper Online (same tables).
 *
 * Work hours: official 9:00–17:00 Kuwait, one hour of grace on arrival.
 *   ≤ 10:00 On time · 10:01–10:15 Minor late · 10:16–10:30 Late · after that Serious late
 * A clock-out before 17:00 counts as early leave unless approved.
 */
export type LateClass = 'On time' | 'Minor late' | 'Late' | 'Serious late';

/** Minutes since midnight, Kuwait time, whatever the device is set to. */
export function kuwaitMinutes(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
  const [h, m] = parts.split(':').map(Number);
  return h * 60 + m;
}

export function lateClassOf(clockInIso: string, workStart = '09:00', graceMin = 60): LateClass {
  const [wh, wm] = workStart.split(':').map(Number);
  const mins = kuwaitMinutes(clockInIso) - (wh * 60 + wm + graceMin);
  if (mins <= 0) return 'On time';
  if (mins <= 15) return 'Minor late';
  if (mins <= 30) return 'Late';
  return 'Serious late';
}

/**
 * Did they leave before their shift ended?
 *
 * The shift end is passed in rather than assumed: it used to default to the
 * office's 17:00 for everybody, which told a manager who finishes at 15:30 that
 * she had left early every day she worked. False when nobody has said when the
 * day ends — unknown, not "left early".
 */
export function isEarlyLeave(clockOutIso: string | null, workEnd: string | null = '17:00'): boolean {
  if (!clockOutIso || !workEnd) return false;
  const [eh, em] = workEnd.split(':').map(Number);
  if (!Number.isFinite(eh) || !Number.isFinite(em)) return false;
  return kuwaitMinutes(clockOutIso) < eh * 60 + em;
}

/**
 * Kuwait Labor Law (Law No. 6 of 2010): annual leave is 30 paid WORKING days.
 * The weekly rest day (Friday) inside a leave period does not consume leave,
 * so the count skips Fridays.
 */
export function workingDaysBetween(startStr: string, endStr: string): number {
  const end = new Date(`${endStr}T12:00:00Z`);
  const d = new Date(`${startStr}T12:00:00Z`);
  let days = 0;
  while (d <= end) {
    if (d.getUTCDay() !== 5) days++; // 5 = Friday
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/** Distance in metres between two coordinates — for the clock-in geofence. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
