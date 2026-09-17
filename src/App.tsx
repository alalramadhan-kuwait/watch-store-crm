import { useEffect, useRef } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { format } from 'date-fns';
import { NavBar } from './components/layout/NavBar';
import { TopBar } from './components/layout/TopBar';
import { Sidebar } from './components/layout/Sidebar';
import { LoginPage } from './components/auth/LoginPage';
import { EntryWithLog } from './components/EntryWithLog';
import { Home } from './components/Home';
import { Team } from './components/Team';
import { More } from './components/More';
import { TodayLog } from './components/TodayLog';
import { FollowUps } from './components/FollowUps';
import { ManagerDashboard } from './components/ManagerDashboard';
import { Reports } from './components/Reports';
import { Settings } from './components/Settings';
import { CRM } from './components/CRM';
import { OutletSelector } from './components/OutletSelector';
import { MyPortal } from './components/MyPortal';
import { ToastContainer } from './components/shared/Toast';
import { AuthProvider, useAuth, canSeePerformance } from './context/AuthContext';
import type { DsrRole } from './context/AuthContext';
import { isDayClosed, closeDay, getCasesByDate, updateCase } from './db';
import { previousDay, dayIsOver } from './utils/dayClose';
import { useAppStore } from './store';

function ProtectedRoute({ children, allow }: { children: React.ReactNode; allow?: (r: DsrRole | null) => boolean }) {
  const { role } = useAuth();
  const ok = allow ? allow(role) : role === 'admin';
  if (!ok) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppShell() {
  const { user, loading, role, profile, onFloor } = useAuth();
  const { sidebarCollapsed, activeOutlet } = useAppStore();
  // Anyone on the floor must have an outlet before entering; derived, not
  // remembered, so a sign-out (which clears the outlet) puts the next login
  // back on the picker. Everyone picks their outlet at the start of each
  // session: the day's report is per-outlet, and people cover for each other
  // between the two shops.
  const outletChosen = !onFloor || !!activeOutlet;

  /* No landing redirect any more. `/` renders the right page for the role, so
     a manager opens on Home and a salesperson on Quick Entry without the app
     navigating away from where somebody deliberately went. */

  // Auto-close safety net: if nobody closed a day, close it once it is over.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    /**
     * Close `date` only if it is genuinely past and had entries.
     *
     * The date guard is the whole point. This used to be a setTimeout aimed at
     * midnight that decided which day to close when it *fired* — and a phone
     * that sleeps defers a pending timer, so on 13 Sep it fired at 12:29 and
     * closed that same day while both shops were still trading. Closing a day
     * that has not ended locks the log for everyone, at every outlet, and the
     * auto-close writes no outlet so no outlet can escape it.
     */
    async function autoCloseIfOver(date: string) {
      if (cancelled || !dayIsOver(date)) return;
      if (await isDayClosed(date)) return;
      // that day's entries decide it — not today's, which is what was asked before
      const cases = await getCasesByDate(date);
      if (cases.length > 0 && !cancelled) await closeDay(date, 'auto-close');
    }

    autoCloseIfOver(previousDay());
    // Polled rather than aimed at midnight: a late or throttled tick now just
    // re-asks about the day before, which is still the right day to close.
    const timer = setInterval(() => autoCloseIfOver(previousDay()), 10 * 60 * 1000);

    return () => { cancelled = true; clearInterval(timer); };
  }, [user]);

  // nothing renders until the profile is known: role decides the outlet gate
  if (loading || (user && !profile)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="flex flex-col items-center gap-4">
          <img src={`${import.meta.env.BASE_URL}tk-logo.png`} alt="TIME KEEPER" className="w-20 h-20 object-contain opacity-60" />
          <div className="w-6 h-6 border-2 border-brand-700 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  // The floor chooses an outlet before entering — admin and office roles skip it
  if (!outletChosen) {
    return (
      <OutletSelector onSelected={() => { /* outletChosen is derived from the store */ }} />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <ToastContainer />
      <TopBar />
      <Sidebar />

      {/* The bar above is fixed and now grows by the status-bar inset, so what
          clears it has to grow by the same amount or the first row of every
          page slides underneath it. */}
      <main
        className={`min-h-screen transition-all duration-200 ${sidebarCollapsed ? 'lg:ml-14' : 'lg:ml-60'}`}
        style={{ paddingTop: 'calc(3.5rem + var(--sa-t))' }}
      >
        <Routes>
          {/* `/` is whichever page that role opens on, so a bookmark, a deep
              link and the Home tab all land in the same place. Entry keeps its
              own address, which is what the Entry tab points at for everyone —
              there is one Quick Entry and no manager variant of it. */}
          <Route path="/" element={canSeePerformance(role) ? <Home /> : <EntryWithLog />} />
          <Route path="/entry" element={<EntryWithLog />} />
          <Route path="/team" element={<ProtectedRoute allow={canSeePerformance}><Team /></ProtectedRoute>} />
          <Route path="/more" element={<More />} />
          <Route path="/today" element={<TodayLog />} />
          <Route path="/followups" element={<FollowUps />} />
          <Route path="/portal" element={<MyPortal />} />
          <Route path="/crm" element={<ProtectedRoute><CRM /></ProtectedRoute>} />
          <Route path="/manager" element={<ProtectedRoute allow={canSeePerformance}><ManagerDashboard /></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute allow={canSeePerformance}><Reports /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <NavBar />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
