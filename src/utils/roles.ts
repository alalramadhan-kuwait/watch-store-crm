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
