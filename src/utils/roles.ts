/**
 * What each role is CALLED, as distinct from what it is stored as.
 *
 * The stored values ('admin', 'staff', …) are written into the database
 * security rules and into role checks across both apps, so they stay exactly
 * as they are. What people read is a separate matter, and the stored word was
 * going straight onto the screen: an owner was labelled "admin" and the shared
 * shop login "staff".
 *
 * Mirrors timekeeper-online/src/lib/roles.ts — the same person sees the same
 * word in both apps.
 */
export const ROLE_LABEL: Record<string, string> = {
  admin: 'Owner',
  manager: 'Manager',
  sales: 'Salesperson',
  operations: 'Operations',
  marketing: 'Marketing',
  staff: 'Shared shop login',
  hr: 'HR',
  viewer: 'Read-only',
};

export const roleLabel = (role: string | null | undefined): string =>
  (role && ROLE_LABEL[role]) || role || '';

/**
 * May this account act under someone else's name?
 *
 * True for the owners, the store manager, and the one shared shop login that
 * several salespeople work from — accounts that are not one identified
 * salesperson. A personal login is only ever itself: it logs sales under its
 * own roster name, edits its own cases, and closes the day as itself.
 *
 * Deliberately a question about the ROLE. This used to be decided by "does the
 * login have a DSR name", which described the shared account by accident: two
 * salespeople were given personal logins with the name left blank, and both
 * got the full staff dropdown on the entry page and the whole shop's follow-up
 * board.
 */
export const canActForOtherStaff = (role: string | null | undefined): boolean =>
  role === 'admin' || role === 'manager' || role === 'staff';
