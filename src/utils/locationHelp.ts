/**
 * What to actually do when the browser refuses to give the page a position.
 *
 * "Allow location for this site in your browser settings" is true and useless.
 * On an iPhone that sentence covers three different screens, and if the page
 * was opened from a link inside another app it cannot be fixed on any of them:
 * a page opened from WhatsApp runs inside WhatsApp's own browser and inherits
 * WhatsApp's location permission, which is usually off. The shop manager sat
 * looking at the old message with "◀ WhatsApp" in his status bar — the one
 * place the advice could not work.
 *
 * So the refusal now says which situation this is and what the next tap is.
 */

const ua = () => navigator.userAgent || '';

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(ua())
  // iPadOS 13+ reports itself as a Mac; a touch screen gives it away.
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Installed to the Home Screen, where the app holds its own permission. */
export const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches
  || ('standalone' in navigator && (navigator as unknown as { standalone: boolean }).standalone === true);

/**
 * Opened from inside another app rather than in the browser proper.
 *
 * Facebook, Instagram and Line name themselves in the user agent. WhatsApp on
 * iOS does not — it hands the link to an in-app Safari that looks like Safari —
 * so it cannot be detected, only described. That is why the iPhone advice leads
 * with it either way: it costs one line to rule out, and it is the commonest
 * cause of a flat refusal on a phone that has location switched on.
 */
export const isKnownInAppBrowser = () => /FBAN|FBAV|Instagram|Line\/|MicroMessenger/.test(ua());

/** The refusal, written for the device holding it. */
export function locationBlockedMessage(): string {
  if (isKnownInAppBrowser()) {
    return 'This page is open inside another app, which is not allowed to use location. '
      + 'Open it in your browser — or add it to your home screen — and clock in from there.';
  }
  if (isIOS() && !isInstalled()) {
    return 'iPhone: location is blocked for this page.\n'
      + '1. Opened from WhatsApp or another app? Tap ••• and choose Open in Safari — a link opened inside another app uses that app’s location permission, which is usually off.\n'
      + '2. In Safari, tap the AA in the address bar → Website Settings → Location → Allow.\n'
      + '3. Still stuck? Settings → Privacy & Security → Location Services must be on, with Safari Websites set to While Using the App.\n'
      + 'Adding this to your home screen fixes it for good.';
  }
  if (isIOS()) {
    return 'Location is blocked for this app. Open Settings → Privacy & Security → Location Services, '
      + 'make sure it is on, then allow location for Daily Store Report.';
  }
  if (/Android/.test(ua())) {
    return 'Location is blocked. Tap the padlock next to the address → Permissions → Location → Allow, '
      + 'then try again. Check Android Settings → Location is switched on too.';
  }
  return 'Location is blocked. Allow location for this site in your browser settings, then try again.';
}

/** The way out when none of that works today. Appended wherever the refusal is
 *  shown, because somebody standing in the shop needs their day recorded now,
 *  not a support ticket. */
export const CORRECTION_FALLBACK =
  'If you cannot fix it now, tap “Ask for a correction” below and your manager will record today for you.';

/**
 * Whether the browser has already made up its mind, asked before the tap.
 *
 * `getCurrentPosition` is the only way to be certain, and it is also the thing
 * that shows the prompt — so this reads the standing answer instead, and only
 * to warn. Not supported everywhere and never throws: an unknown answer is
 * treated as "it might be fine", which is what tapping the button will settle.
 */
export async function locationAlreadyDenied(): Promise<boolean> {
  try {
    const p = (navigator as Navigator & { permissions?: Permissions }).permissions;
    if (!p?.query) return false;
    const st = await p.query({ name: 'geolocation' as PermissionName });
    return st.state === 'denied';
  } catch {
    return false;
  }
}
