/**
 * One shop, spelled four ways.
 *
 * The same place is written differently in every table it appears in:
 *
 *   cases.outlet                  'TimeGallery'    (no space)
 *   attendance_records.location   'Time Gallery'
 *   employees.location            'Time Gallery'
 *   settings.outlets              'TimeGallery'
 *   geofences.name                'Time Gallery'
 *   lightspeed_sales_daily.outlet 'Time Keeper - Avenues'
 *
 * Nothing had to join them before — sales were read by outlet and attendance by
 * person, and the two never met. A manager's home page is exactly the join:
 * this shop's takings beside this shop's staff. Compared as typed, Time Gallery
 * would show its sales and nobody working, every day.
 *
 * The list itself now lives in src/shared/outlets.ts, mirrored in the back
 * office and in the database, so both apps recognise the same spellings and
 * agree on which outlets are shops. This file is the shop-floor app's shorthand
 * over it; nothing is renamed in the data.
 */
import {
  outletKey as sharedKey,
  sameOutlet as sharedSame,
  tracksStoreDay,
  resolveOutlet,
  outletName,
} from '../shared/outlets';

export { resolveOutlet, outletName };

/** Lower-case, letters and digits only: 'Time Gallery', 'TimeGallery' and
 *  'time-gallery' all become 'timegallery'. */
export const outletKey = sharedKey;

export const sameOutlet = sharedSame;

/**
 * The places that are actually shops.
 *
 * `settings.outlets` also carries 'WhatsApp', which is a channel a sale can come
 * through rather than somewhere a person stands. It belongs in the entry form
 * and nowhere near "is the store open". Head office is a workplace with
 * attendance but no till, so it is not a store either. Which is which is
 * recorded in the registry rather than kept as a list of exceptions here.
 */
export const isShop = (name: string | null | undefined): boolean => tracksStoreDay(name);

/** The shops, in the order Settings lists them. */
export const shopsFrom = (outlets: string[] | null | undefined): string[] =>
  (outlets ?? []).filter(isShop);

/** Find the caller's spelling of an outlet in a list written in another. Used to
 *  turn an attendance location into the outlet string the rest of the app uses. */
export const matchOutlet = (name: string | null | undefined, outlets: string[]): string | null =>
  outlets.find((o) => sameOutlet(o, name)) ?? null;
