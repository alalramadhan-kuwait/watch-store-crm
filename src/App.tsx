import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { format } from 'date-fns';
import { NavBar } from './components/layout/NavBar';
import { TopBar } from './components/layout/TopBar';
import { Sidebar } from './components/layout/Sidebar';
import { LoginPage } from './components/auth/LoginPage';
import { QuickEntry } from './components/QuickEntry';
import { TodayLog } from './components/TodayLog';
import { FollowUps } from './components/FollowUps';
import { ManagerDashboard } from './components/ManagerDashboard';
import { Settings } from './components/Settings';
import { ToastContainer } from './components/shared/Toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import { isDayClosed, closeDay, getTodayCases, updateCase } from './db';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();
  if (role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppShell() {
  const { user, loading } = useAuth();

  // Auto-close safety net: check yesterday on startup
  useEffect(() => {
    if (!user) return;
    async function checkAutoClose() {
      const yesterday = format(new Date(Date.now() - 86400000), 'yyyy-MM-dd');
      const closed = await isDayClosed(yesterday);
      if (!closed) {
        const cases = await getTodayCases();
        if (cases.length > 0) await closeDay(yesterday, 'auto-close');
      }
    }
    checkAutoClose();

    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
    const timer = setTimeout(async () => {
      const today = format(new Date(), 'yyyy-MM-dd');
      const closed = await isDayClosed(today);
      if (!closed) {
        const cases = await getTodayCases();
        if (cases.length > 0) await closeDay(today, 'auto-close');
      }
    }, midnight.getTime() - now.getTime());

    return () => clearTimeout(timer);
  }, [user]);

  if (loading) {
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

  return (
    <div className="min-h-screen bg-slate-50">
      <ToastContainer />
      <TopBar />
      <Sidebar />

      <main className="min-h-screen pt-14 lg:ml-60">
        <Routes>
          <Route path="/" element={<QuickEntry />} />
          <Route path="/today" element={<TodayLog />} />
          <Route path="/followups" element={<FollowUps />} />
          <Route path="/manager" element={<ProtectedRoute><ManagerDashboard /></ProtectedRoute>} />
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
