import { NavLink } from 'react-router-dom';
import { PlusCircle, ClipboardList, Bell, BarChart2, Settings, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export function Sidebar() {
  const { profile, role, signOut } = useAuth();

  const items = [
    { to: '/',          icon: PlusCircle,    label: 'Quick Entry' },
    { to: '/today',     icon: ClipboardList, label: "Today's Log" },
    { to: '/followups', icon: Bell,          label: 'Follow-ups'  },
    ...(role === 'admin' ? [
      { to: '/manager',  icon: BarChart2, label: 'Dashboard' },
      { to: '/settings', icon: Settings,  label: 'Settings'  },
    ] : []),
  ];

  return (
    <nav className="hidden lg:flex fixed left-0 top-14 bottom-0 w-60 bg-white border-r border-slate-100 flex-col z-20">
      {/* User info */}
      <div className="px-4 py-4 border-b border-slate-100">
        <p className="text-sm font-semibold text-slate-800 truncate">{profile?.full_name ?? '—'}</p>
        <p className="text-xs text-slate-400 capitalize">{role ?? ''}</p>
      </div>

      {/* Nav items */}
      <div className="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto">
        {items.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ` +
              (isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900')
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </div>

      {/* Sign out */}
      <div className="p-3 border-t border-slate-100">
        <button
          onClick={signOut}
          className="flex items-center gap-3 px-3 py-2.5 w-full rounded-xl text-sm font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <LogOut className="w-4 h-4" /> Sign Out
        </button>
      </div>
    </nav>
  );
}
