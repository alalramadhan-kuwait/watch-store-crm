import { LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useAppStore } from '../../store';

export function TopBar() {
  const { profile, role, signOut } = useAuth();
  const { sidebarCollapsed, setSidebarCollapsed } = useAppStore();

  const sidebarW = sidebarCollapsed ? 'lg:pl-14' : 'lg:pl-60';

  return (
    <header className="fixed top-0 left-0 right-0 z-30 bg-white border-b border-slate-100">
      <div className={`flex items-center justify-between ${sidebarW} transition-all duration-200`}>
        {/* Mobile: sign out placeholder (keeps brand centered) */}
        {profile && (
          <div className="lg:hidden w-10" />
        )}

        {/* Desktop: sidebar toggle */}
        {profile && (
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="hidden lg:flex items-center justify-center w-9 h-9 ml-3 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors shrink-0"
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            {sidebarCollapsed
              ? <PanelLeftOpen className="w-4 h-4" />
              : <PanelLeftClose className="w-4 h-4" />}
          </button>
        )}

        {/* Brand — centered on mobile, left-aligned content area on desktop */}
        <div className="flex-1 flex flex-col items-center justify-center py-2.5 lg:items-start lg:pl-4">
          <span className="tk-wordmark text-[13px] text-slate-900 leading-none">Time Keeper</span>
          <span className="tk-sub text-[8px] text-slate-400 mt-1 leading-none">Est. 2018</span>
        </div>

        {/* Mobile: sign out icon */}
        {profile && (
          <button
            onClick={signOut}
            className="lg:hidden p-2 mr-1 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-colors touch-manipulation"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        )}

        {/* Desktop: show user + sign out */}
        {profile && (
          <div className="hidden lg:flex items-center gap-4 pr-6">
            <span className="text-xs text-slate-500">
              {profile.full_name}
              <span className="ml-1.5 px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 capitalize text-[10px] font-medium">{role}</span>
            </span>
            <button
              onClick={signOut}
              className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
