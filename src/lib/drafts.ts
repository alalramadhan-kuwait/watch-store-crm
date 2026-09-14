/* What you had typed.

   A sale being logged is the one thing in the DSR that lives only on the
   device: until Save it exists nowhere else. A phone locks between customers,
   iOS reclaims the tab, someone takes a call — and the form was gone.

   So Quick Entry keeps a draft as it is filled in, and offers it back when the
   app is reopened. Offers, not applies silently: the person coming back may be
   a different person, or may have meant to start again. The form says a draft
   was restored and lets them discard it.

   Drafts are per user, because one phone behind a counter is used by several
   people on the same shared login and by different logins across a shift. */
const TTL = 12 * 60 * 60 * 1000;   // a shift; a sale half-logged this morning is still worth offering back

const key = (user: string | null | undefined, name: string) => `dsr:draft:${user ?? 'anon'}:${name}`;

export function readDraft<T>(user: string | null | undefined, name: string): T | null {
  try {
    const raw = localStorage.getItem(key(user, name));
    if (!raw) return null;
    const { at, form } = JSON.parse(raw) as { at: number; form: T };
    if (typeof at !== 'number' || Date.now() - at > TTL) {
      localStorage.removeItem(key(user, name));
      return null;
    }
    return form ?? null;
  } catch { return null; }
}

export function writeDraft(user: string | null | undefined, name: string, form: unknown) {
  try { localStorage.setItem(key(user, name), JSON.stringify({ at: Date.now(), form })); }
  catch { /* full, or private mode — a lost draft is not worth an error */ }
}

export function clearDraft(user: string | null | undefined, name: string) {
  try { localStorage.removeItem(key(user, name)); } catch { /* ignore */ }
}

/** Signing out takes this user's drafts with it — the next person on the floor
    must not be handed someone else's half-logged sale. */
export function clearAllDrafts(user: string | null | undefined) {
  try {
    const prefix = `dsr:draft:${user ?? 'anon'}:`;
    for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
