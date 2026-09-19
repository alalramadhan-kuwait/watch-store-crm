import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LogOut, PanelLeftClose, PanelLeftOpen, Bell } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { unreadCount } from '../../shared/notifications';
import { useAppStore } from '../../store';
import pkg from '../../../package.json';
import { roleLabel } from '../../utils/roles';

export function TopBar() {
  const { profile, role, signOut } = useAuth();
  const { sidebarCollapsed, setSidebarCollapsed } = useAppStore();

  const sidebarW = sidebarCollapsed ? 'lg:pl-14' : 'lg:pl-60';

  /* The bell. This app raised no notifications to anybody until now, so the
     count starting at zero is accurate rather than lazy. Polled every minute:
     the flush job runs every thirty seconds, and a manager does not need to
     know faster than he can walk across the shop. */
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!profile) { setUnread(0); return; }
    let live = true;
    const tick = () => { void unreadCount(profile.id, role, { shopFloorOnly: true }).then((n) => { if (live) setUnread(n); }); };
    tick();
    const t = setInterval(tick, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [profile, role]);

  /* inline-flex, not the anchor's default inline: an inline box is only as
     wide as the glyph inside it, so the padding never counted and the badge
     below — positioned against that box — landed above and to the left of
     the bell, half of it off the side of the screen. */
  const bell = (
    <NavLink to="/notifications" aria-label="Notifications"
      className="relative inline-flex items-center justify-center p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-colors touch-manipulation">
      <Bell className="w-4 h-4" />
      {unread > 0 && (
        <span className="absolute top-1 right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-rose-500
                         text-white text-[9px] font-bold leading-[15px] text-center tabular-nums">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </NavLink>
  );

  return (
    <header className="fixed top-0 left-0 right-0 z-30 bg-white border-b border-slate-100 safe-area-top safe-area-x">
      <div className={`flex items-center justify-between ${sidebarW} transition-all duration-200`}>
        {/* Mobile: notifications */}
        {profile && <div className="lg:hidden ml-1">{bell}</div>}

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
          <div className="flex items-center gap-2 mt-1">
            <span className="tk-sub text-[8px] text-slate-400 leading-none">Daily Store Report</span>
            <span className="text-[8px] font-semibold text-slate-300 leading-none">v{pkg.version}{__BUILD_SHA__ && ` · ${__BUILD_SHA__}`}</span>
          </div>
          {/* Which account is signed in. The desktop bar has always said so on
              the right; on a phone there was nothing, and these are shared
              devices — someone could log a sale under a colleague still signed
              in and never see it. */}
          {profile && (
            <div className="lg:hidden flex items-center gap-1.5 mt-1.5 max-w-full px-4">
              <span className="text-[11px] font-medium text-slate-600 truncate">{profile.full_name}</span>
              <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[9px] font-medium leading-none">
                {roleLabel(role)}
              </span>
            </div>
          )}
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
          <div className="hidden lg:flex items-center gap-2 pr-6">
            {bell}
            <span className="text-xs text-slate-500">
              {profile.full_name}
              <span className="ml-1.5 px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 text-[10px] font-medium">{roleLabel(role)}</span>
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
