/**
 * One shop, spelled four ways.
 *
 * The same place is written differently in every table it appears in:
 *
 *   cases.outlet                'TimeGallery'    (no space)
 *   attendance_records.location 'Time Gallery'
 *   employees.location          'Time Gallery'
 *   settings.outlets            'TimeGallery'
 *   geofences.name              'Time Gallery'
 *
 * Nothing had to join them before — sales were read by outlet and attendance by
 * person, and the two never met. A manager's home page is exactly the join:
 * this shop's takings beside this shop's staff. Compared as typed, Time Gallery
 * would show its sales and nobody working, every day.
 *
 * Matching is done through a key rather than by renaming the data. The strings
 * are in hundreds of case rows, in saved settings and in a session's chosen
 * outlet; changing them is a migration with a blast radius, and it can happen
 * later without touching anything that uses this.
 */

/** Lower-case, letters and digits only: 'Time Gallery', 'TimeGallery' and
 *  'time-gallery' all become 'timegallery'. */
export const outletKey = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const sameOutlet = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const ka = outletKey(a);
  return !!ka && ka === outletKey(b);
};

/**
 * The places that are actually shops.
 *
 * `settings.outlets` also carries 'WhatsApp', which is a channel a sale can come
 * through rather than somewhere a person stands. It belongs in the entry form and
 * nowhere near "is the store open". Head office is a workplace with attendance
 * but no till, so it is not a store either.
 */
const NOT_A_SHOP = new Set([outletKey('WhatsApp'), outletKey('Timekeeper HQ'), outletKey('Online')]);

export const isShop = (name: string | null | undefined): boolean => {
  const k = outletKey(name);
  return !!k && !NOT_A_SHOP.has(k);
};

/** The shops, in the order Settings lists them. */
export const shopsFrom = (outlets: string[] | null | undefined): string[] =>
  (outlets ?? []).filter(isShop);

/** Find the caller's spelling of an outlet in a list written in another. Used to
 *  turn an attendance location into the outlet string the rest of the app uses. */
export const matchOutlet = (name: string | null | undefined, outlets: string[]): string | null =>
  outlets.find((o) => sameOutlet(o, name)) ?? null;
