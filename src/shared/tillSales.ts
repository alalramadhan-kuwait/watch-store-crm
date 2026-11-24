/**
 * The month's till sales against the monthly target, the one way both apps add
 * them up.
 *
 * The monthly target (110,000 when this was written) is the sum of the four
 * regular channels' own targets: Avenues, Time Gallery, Online and WhatsApp.
 * Only those four count toward it. A register the outlet registry does not know
 * — the Expo stand of 5–12 Nov was one, with `channel_code` NULL in
 * `pos_channel_sales` — is an event: shown as its own line with its dates and
 * sale count, and no target. On 24 Nov Today added the Expo's 80.3k to 61.0k of
 * regular sales, called it 129% of target, and projected the one-off week
 * forward to 184k for the month.
 *
 * Whether event sales should count toward the target is the owner's call and
 * has not been made. Until it is, the regular figure is the one judged, and the
 * event line says it is not in it.
 *
 * Pace is measured in till days: a month whose sales run to the 23rd is 23 days
 * in, whatever the clock says, because the tills sync once a morning.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */
import { OUTLETS, sellingOutlets, type Outlet, type OutletCode } from './outlets';

/** A row of the `pos_channel_sales` view. */
export interface TillRow {
  channel_code: string | null;
  /** The register's own name, used to name an event that has no channel. */
  outlet?: string | null;
  sale_date: string;
  revenue: unknown;
  sale_count?: unknown;
}

export interface ChannelMonth {
  code: OutletCode;
  sales: number;
  count: number;
  target: number | null;
  /** Percent of its own target, unrounded; null with no target. */
  pct: number | null;
}

export interface EventMonth {
  /** The register's name, e.g. "Expo". */
  name: string;
  from: string;
  to: string;
  sales: number;
  count: number;
}

export interface MonthSales {
  month: string;
  daysInMonth: number;
  /** The last day any till recorded a sale this month. */
  lastSaleDay: string | null;
  /** Days of the month the tills have counted (the day of lastSaleDay). */
  tillDays: number | null;
  /** tillDays / daysInMonth: where a channel on target should be by now. */
  paceFrac: number | null;
  /** The regular channels, in registry order. */
  channels: ChannelMonth[];
  /** The regular channels together: the figure the monthly target is about. */
  regular: {
    sales: number;
    count: number;
    target: number | null;
    pct: number | null;
    /** Month-end at the current daily rate; null before the first till day. */
    projected: number | null;
    /** target − projected; positive means short. */
    projectedShort: number | null;
  };
  /** Registers outside the registry (events). Never part of the target. */
  events: EventMonth[];
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** "2026-11" → 30. */
export const daysInMonthOf = (month: string): number => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * Add up a month of till rows.
 *
 * `targets` holds each channel's own monthly target; `monthTarget` the company
 * one. Rows outside `month` are ignored, so a caller may pass a wider read.
 */
export function monthSales(
  rows: TillRow[],
  opts: {
    month: string;
    targets: Partial<Record<OutletCode, number | null>>;
    monthTarget: number | null;
    registry?: Outlet[];
  },
): MonthSales {
  const registry = opts.registry ?? OUTLETS;
  const regularCodes = new Set<string>(sellingOutlets(registry).map((o) => o.code));
  const inMonth = rows.filter((r) => r.sale_date.slice(0, 7) === opts.month);
  const daysInMonth = daysInMonthOf(opts.month);

  const lastSaleDay = inMonth.reduce<string | null>((m, r) => (m === null || r.sale_date > m ? r.sale_date : m), null);
  const tillDays = lastSaleDay ? Number(lastSaleDay.slice(8, 10)) : null;
  const paceFrac = tillDays ? tillDays / daysInMonth : null;

  const pctOf = (v: number, t: number | null) => (t ? (v / t) * 100 : null);

  const channels: ChannelMonth[] = sellingOutlets(registry).map((o) => {
    const mine = inMonth.filter((r) => r.channel_code === o.code);
    const sales = mine.reduce((t, r) => t + n(r.revenue), 0);
    const target = opts.targets[o.code] ?? null;
    return { code: o.code, sales, count: mine.reduce((t, r) => t + n(r.sale_count), 0), target, pct: pctOf(sales, target) };
  });

  const regRows = inMonth.filter((r) => r.channel_code !== null && regularCodes.has(r.channel_code));
  const regSales = regRows.reduce((t, r) => t + n(r.revenue), 0);
  const target = opts.monthTarget ?? null;
  const projected = tillDays ? (regSales / tillDays) * daysInMonth : null;

  /* Anything that is not a regular channel: an unregistered register, or a
     channel code the registry does not know. Named by its register. */
  const byEvent = new Map<string, EventMonth>();
  for (const r of inMonth) {
    if (r.channel_code !== null && regularCodes.has(r.channel_code)) continue;
    const name = (r.outlet ?? '').trim() || r.channel_code || 'Unassigned register';
    const e = byEvent.get(name) ?? { name, from: r.sale_date, to: r.sale_date, sales: 0, count: 0 };
    e.sales += n(r.revenue);
    e.count += n(r.sale_count);
    if (r.sale_date < e.from) e.from = r.sale_date;
    if (r.sale_date > e.to) e.to = r.sale_date;
    byEvent.set(name, e);
  }
  const events = [...byEvent.values()]
    .filter((e) => Math.abs(e.sales) > 0.0005 || e.count !== 0)
    .sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name));

  return {
    month: opts.month,
    daysInMonth,
    lastSaleDay,
    tillDays,
    paceFrac,
    channels,
    regular: {
      sales: regSales,
      count: regRows.reduce((t, r) => t + n(r.sale_count), 0),
      target,
      pct: pctOf(regSales, target),
      projected,
      projectedShort: projected !== null && target ? target - projected : null,
    },
    events,
  };
}

/** "5–12 Nov", "12 Nov" or "28 Oct – 2 Nov" for an event's dates. */
export function eventDates(from: string, to: string): string {
  const mon = (d: string) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7)) - 1];
  const dd = (d: string) => String(Number(d.slice(8, 10)));
  if (from === to) return `${dd(from)} ${mon(from)}`;
  if (from.slice(0, 7) === to.slice(0, 7)) return `${dd(from)}–${dd(to)} ${mon(to)}`;
  return `${dd(from)} ${mon(from)} – ${dd(to)} ${mon(to)}`;
}
