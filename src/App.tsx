import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { format } from 'date-fns';
import { NavBar } from './components/layout/NavBar';
import { TopBar } from './components/layout/TopBar';
import { ManagerLogin } from './components/layout/ManagerGate';
import { QuickEntry } from './components/QuickEntry';
import { TodayLog } from './components/TodayLog';
import { FollowUps } from './components/FollowUps';
import { ManagerDashboard } from './components/ManagerDashboard';
import { Settings } from './components/Settings';
import { ToastContainer } from './components/shared/Toast';
import { useAppStore } from './store';
import { db, isDayClosed, closeDay } from './db';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isManagerAuthed } = useAppStore();
  if (!isManagerAuthed) {
    return <Navigate to="/manager-login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  // Auto-close safety net: check at startup and schedule midnight check
  useEffect(() => {
    async function checkAutoClose() {
      const yesterday = format(new Date(Date.now() - 86400000), 'yyyy-MM-dd');
      const yesterdayClosed = await isDayClosed(yesterday);
      if (!yesterdayClosed) {
        const count = await db.cases.where('dateLogged').equals(yesterday).count();
        if (count > 0) {
          await closeDay(yesterday, 'auto-close');
        }
      }
    }

    checkAutoClose();

    // Schedule next check at next midnight
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
    const msUntilMidnight = midnight.getTime() - now.getTime();
    const timer = setTimeout(() => {
      const today = format(new Date(), 'yyyy-MM-dd');
      isDayClosed(today).then(closed => {
        if (!closed) {
          db.cases.where('dateLogged').equals(today).count().then(count => {
            if (count > 0) closeDay(today, 'auto-close');
          });
        }
      });
    }, msUntilMidnight);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      <ToastContainer />
      <TopBar />

      {/* Main content area — padded for TopBar (top) and NavBar (bottom) */}
      <main className="min-h-screen pt-14">
        <Routes>
          <Route path="/" element={<QuickEntry />} />
          <Route path="/today" element={<TodayLog />} />
          <Route path="/followups" element={<FollowUps />} />
          <Route path="/manager-login" element={<ManagerLogin />} />
          <Route
            path="/manager"
            element={
              <ProtectedRoute>
                <ManagerDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Settings />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <NavBar />
    </div>
  );
}
