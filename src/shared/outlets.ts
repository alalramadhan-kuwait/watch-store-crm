/**
 * The one list of outlets and channels, and the only safe way to compare them.
 *
 * Four places a sale can come from and one office. Two of the four are shops
 * you can stand in; the other two are a website and a phone. Only a shop has
 * attendance, a geofence and an opening time — a digital channel must never
 * behave like a store just because somebody sells through it.
 *
 * Every other system spells these differently: the POS says `Time Keeper -
 * Avenues`, the DSR says `Avenues`, the HR record says `Avenues`, and the
 * shop-floor app used to say `TimeGallery`. Nothing is renamed; the aliases
 * below are how old values keep working. Compare outlets with `sameOutlet` or
 * `resolveOutlet`, never with `===`.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */

export type OutletCode = 'avenues' | 'time_gallery' | 'whatsapp' | 'online' | 'hq';

export interface Outlet {
  code: OutletCode;
  displayName: string;
  kind: 'physical' | 'digital';
  /** Appears in sales and revenue reporting. */
  sells: boolean;
  /** Staff clock in here. */
  hasAttendance: boolean;
  hasGeofence: boolean;
  /** Opens and closes, derived from attendance. */
  tracksStoreDay: boolean;
  geofenceName: string | null;
  /** lightspeed_sales_daily.outlet */
  posNames: string[];
  /** cases.outlet, settings.outlets */
  dsrNames: string[];
  aliases: string[];
  sortOrder: number;
  active: boolean;
}

/**
 * Mirrors the `outlets` table. Kept in code as well as in the database so the
 * apps resolve outlets before the registry has loaded, and offline.
 */
export const OUTLETS: Outlet[] = [
  {
    code: 'avenues',
    displayName: 'Time Keeper - Avenues',
    kind: 'physical',
    sells: true,
    hasAttendance: true,
    hasGeofence: true,
    tracksStoreDay: true,
    geofenceName: 'Avenues',
    posNames: ['Time Keeper - Avenues'],
    dsrNames: ['Avenues'],
    aliases: ['Avenues', 'The Avenues', 'TimeKeeper Avenues', 'Time Keeper Avenues', 'TK Avenues'],
    sortOrder: 10,
    active: true,
  },
  {
    code: 'time_gallery',
    displayName: 'Time Gallery',
    kind: 'physical',
    sells: true,
    hasAttendance: true,
    hasGeofence: true,
    tracksStoreDay: true,
    geofenceName: 'Time Gallery',
    posNames: ['Time Gallery'],
    dsrNames: ['TimeGallery'],
    aliases: ['Time Gallery', 'TimeGallery', 'Gallery', 'Salhiya'],
    sortOrder: 20,
    active: true,
  },
  {
    code: 'whatsapp',
    displayName: 'Time Keeper WhatsApp',
    kind: 'digital',
    sells: true,
    hasAttendance: false,
    hasGeofence: false,
    tracksStoreDay: false,
    geofenceName: null,
    posNames: ['Time Keeper'],
    dsrNames: ['WhatsApp'],
    aliases: ['WhatsApp', 'Whats App', 'Time Keeper', 'TimeKeeper', 'WA'],
    sortOrder: 30,
    active: true,
  },
  {
    code: 'online',
    displayName: 'Time Keeper Online',
    kind: 'digital',
    sells: true,
    hasAttendance: false,
    hasGeofence: false,
    tracksStoreDay: false,
    geofenceName: null,
    posNames: [],
    dsrNames: [],
    aliases: ['Online', 'Time Keeper Online', 'Webshop', 'Web Shop', 'Website', 'E-commerce'],
    sortOrder: 40,
    active: true,
  },
  {
    // The office. People clock in here, but nothing is sold and it does not
    // open or close the way a shop does.
    code: 'hq',
    displayName: 'Timekeeper HQ',
    kind: 'physical',
    sells: false,
    hasAttendance: true,
    hasGeofence: true,
    tracksStoreDay: false,
    geofenceName: 'Timekeeper HQ',
    posNames: [],
    dsrNames: [],
    aliases: ['Timekeeper HQ', 'Time Keeper HQ', 'HQ', 'Head Office', 'Office'],
    sortOrder: 50,
    active: true,
  },
];

/** Comparison key: lowercase, letters and digits only. Mirrors outlet_key(). */
export const outletKey = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const every = (o: Outlet): string[] =>
  [o.code, o.displayName, ...o.posNames, ...o.dsrNames, ...o.aliases];

/** Any historical spelling to its canonical code, or null when unknown. */
export function resolveOutlet(
  value: string | null | undefined,
  registry: Outlet[] = OUTLETS,
): OutletCode | null {
  const key = outletKey(value);
  if (!key) return null;
  const hit = [...registry]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .find((o) => every(o).some((name) => outletKey(name) === key));
  return hit ? hit.code : null;
}

/** The registry row for a value, however it was spelled. */
export const outletOf = (
  value: string | null | undefined,
  registry: Outlet[] = OUTLETS,
): Outlet | null => {
  const code = resolveOutlet(value, registry);
  return code ? registry.find((o) => o.code === code) ?? null : null;
};

/** True when two differently-spelled values mean the same outlet. */
export const sameOutlet = (
  a: string | null | undefined,
  b: string | null | undefined,
  registry: Outlet[] = OUTLETS,
): boolean => {
  const ra = resolveOutlet(a, registry);
  return ra !== null && ra === resolveOutlet(b, registry);
};

/** What to show a person. Falls back to the raw value for anything unknown. */
export const outletName = (
  value: string | null | undefined,
  registry: Outlet[] = OUTLETS,
): string => outletOf(value, registry)?.displayName ?? (value ?? '—');

export const isPhysical = (v: string | null | undefined, r: Outlet[] = OUTLETS): boolean =>
  outletOf(v, r)?.kind === 'physical';

export const isDigital = (v: string | null | undefined, r: Outlet[] = OUTLETS): boolean =>
  outletOf(v, r)?.kind === 'digital';

/** Does this outlet open and close? Shops only — never Online or WhatsApp. */
export const tracksStoreDay = (v: string | null | undefined, r: Outlet[] = OUTLETS): boolean =>
  outletOf(v, r)?.tracksStoreDay === true;

/** Do people clock in here? Shops and the office. */
export const hasAttendance = (v: string | null | undefined, r: Outlet[] = OUTLETS): boolean =>
  outletOf(v, r)?.hasAttendance === true;

/** The shops, in display order — the ones with a floor to staff. */
export const shops = (registry: Outlet[] = OUTLETS): Outlet[] =>
  registry.filter((o) => o.active && o.tracksStoreDay).sort((a, b) => a.sortOrder - b.sortOrder);

/** Everything a sale can be booked against, shops and channels alike. */
export const sellingOutlets = (registry: Outlet[] = OUTLETS): Outlet[] =>
  registry.filter((o) => o.active && o.sells).sort((a, b) => a.sortOrder - b.sortOrder);

/** Row shape returned by `select *` on the outlets table. */
export interface OutletRow {
  code: string;
  display_name: string;
  kind: string;
  sells: boolean;
  has_attendance: boolean;
  has_geofence: boolean;
  tracks_store_day: boolean;
  geofence_name: string | null;
  pos_names: string[] | null;
  dsr_names: string[] | null;
  aliases: string[] | null;
  sort_order: number;
  active: boolean;
}

/** Database rows to registry entries, for apps that load the live table. */
export const outletsFromRows = (rows: OutletRow[]): Outlet[] =>
  rows.map((r) => ({
    code: r.code as OutletCode,
    displayName: r.display_name,
    kind: r.kind === 'digital' ? 'digital' : 'physical',
    sells: r.sells,
    hasAttendance: r.has_attendance,
    hasGeofence: r.has_geofence,
    tracksStoreDay: r.tracks_store_day,
    geofenceName: r.geofence_name,
    posNames: r.pos_names ?? [],
    dsrNames: r.dsr_names ?? [],
    aliases: r.aliases ?? [],
    sortOrder: r.sort_order,
    active: r.active,
  }));
