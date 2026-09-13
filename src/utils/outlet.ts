/**
 * The HR record spells outlets for people ('Time Gallery') and the sales
 * tables spell them for keys ('TimeGallery'). Compare them by letters only,
 * so a person's home location can pick the matching sales outlet.
 */
export const outletKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The settings.outlets entry that matches an HR location, or null. */
export const matchOutlet = (location: string | null | undefined, outlets: string[]): string | null =>
  location ? outlets.find(o => outletKey(o) === outletKey(location)) ?? null : null;
