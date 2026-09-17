import { createContext, useContext, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useAppStore } from '../store';
import { clearAllDrafts } from '../lib/drafts';

// Roles the shared project uses that this app can meet. Only admin and the
// floor roles have behaviour here; the others are named so they stop being a
// silent branch.
export type DsrRole = 'admin' | 'staff' | 'sales' | 'manager' | 'viewer';

// Everyone who works a shop floor: 'staff' (the shared login), 'sales' (a
// personal login) and 'manager' (the store manager, who runs both shops and
// sells in them — 476 of the cases on the board are his). They behave
// identically here: pick an outlet, see that outlet's day, log cases. Three
// words for it because Team Access offers all three, so the app must not care
// which one was picked.
export const isFloorRole = (r: DsrRole | null) =>
  r === 'staff' || r === 'sales' || r === 'manager';

// The store manager runs both shops: he sees the numbers (Dashboard, Reports)
// but not the books (CRM) or the keys (Settings, where logins are made).
// Owners keep everything.
export const canSeePerformance = (r: DsrRole | null) => r === 'admin' || r === 'manager';

export interface Profile {
  id: string;
  full_name: string;
  role: DsrRole;
  // The staff-roster name this login's sales are logged under. Set for
  // personal logins; null on the shared login, which keeps its dropdown.
  sales_name: string | null;
}

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  role: DsrRole | null;
  /** Roster name for a personal login; null = pick from the dropdown. */
  salesName: string | null;
  /** Sells on the floor — role 'staff' or 'sales'. Drives the outlet gate. */
  onFloor: boolean;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  role: null,
  salesName: null,
  onFloor: false,
  loading: true,
  signIn: async () => ({ error: 'Not initialized' }),
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  /* The roster name a login sells under is stored twice — profiles.sales_name,
     which the DSR reads, and employees.dsr_staff_name on the HR record. A
     salesperson was set up with the HR one filled in and the login one left
     blank, and spent a morning looking at "Your DSR name isn't set yet" while
     the answer sat in the next table.
     So the HR record is the fallback. Only for a salesperson: the shared shop
     login and a manager are deliberately nameless — that is what makes their
     board show the whole shop — and inheriting a name would quietly narrow it. */
  const [rosterFallback, setRosterFallback] = useState<string | null>(null); // employees.dsr_staff_name

  async function loadProfile(userId: string) {
    // per-user device memory (last staff picked) is keyed by the login
    useAppStore.getState().hydrateForUser(userId);
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, role, sales_name')
      .eq('id', userId)
      .single();
    if (data) setProfile(data as Profile);

    /* The roster name lives on the employee record — the row that also carries
       their shop, their schedule and their leave. profiles.sales_name is a
       mirror kept in step by a trigger, and is only read for an account with no
       employee record linked. Reading the mirror first is what locked a
       salesperson out of the DSR: hers had been filled in one place only. */
    const { data: emp } = await supabase
      .from('employees').select('dsr_staff_name').eq('user_id', userId).maybeSingle();
    setRosterFallback((emp as { dsr_staff_name?: string | null } | null)?.dsr_staff_name ?? null);
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setUser(session?.user ?? null);
      // stay in "loading" until the profile is here, so nothing renders with role === null
      if (session?.user) await loadProfile(session.user.id);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) loadProfile(session.user.id);
      else setProfile(null);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  }

  async function signOut() {
    // Outlet and last-staff memory belong to the person, not the device:
    // the next login on this phone must not inherit them. Nor must an entry
    // the outgoing person had half typed.
    useAppStore.getState().clearSessionState();
    clearAllDrafts(user?.id);
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{
      user, profile, role: profile?.role ?? null,
      salesName: rosterFallback ?? profile?.sales_name ?? null,
      onFloor: isFloorRole(profile?.role ?? null),
      loading, signIn, signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
