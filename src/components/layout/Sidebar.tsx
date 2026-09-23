import { NavLink } from 'react-router-dom';
import { PlusCircle, ClipboardList, Bell, BarChart2, FileText, Settings, LogOut, Users, UserRound, Home, Users2 } from 'lucide-react';
import { useAuth, canSeePerformance } from '../../context/AuthContext';
import { useAppStore } from '../../store';
import { VersionChip } from '../WhatsNew';
import { roleLabel } from '../../utils/roles';

export function Sidebar() {
  const { profile, role, signOut } = useAuth();
  const { sidebarCollapsed } = useAppStore();

  /* A desk has room the phone does not, so nothing is hidden behind More here.
     The order still matches the bottom bar, and `/` means the same thing in
     both: whichever page this role opens on. */
  const perf = canSeePerformance(role);
  const items = [
    { to: '/',          icon: Home,          label: 'Home'        },
    { to: '/entry',     icon: PlusCircle,    label: 'Log a visit' },
    { to: '/today',     icon: ClipboardList, label: "Today's Log" },
    { to: '/followups', icon: Bell,          label: 'Follow-ups'  },
    { to: '/crm',       icon: Users,         label: 'Customers'   },
    ...(perf ? [{ to: '/team', icon: Users2, label: 'Team' }] : []),
    { to: '/portal',    icon: UserRound,     label: 'My Portal'   },
    // the store manager runs both shops: the numbers yes, Settings no
    ...(perf ? [
      { to: '/manager',  icon: BarChart2,  label: 'Dashboard' },
      { to: '/reports',  icon: FileText,   label: 'Reports'   },
    ] : []),
    ...(role === 'admin' ? [
      { to: '/settings', icon: Settings,   label: 'Settings'  },
    ] : []),
  ];

  const w = sidebarCollapsed ? 'w-14' : 'w-60';

  return (
    <nav className={`hidden lg:flex fixed left-0 top-14 bottom-0 ${w} bg-white border-r border-slate-100 flex-col z-20 transition-all duration-200 overflow-hidden`}>

      {/* User info — hidden when collapsed */}
      {!sidebarCollapsed && (
        <div className="px-4 py-4 border-b border-slate-100 shrink-0">
          <p className="text-sm font-semibold text-slate-800 truncate">{profile?.full_name ?? '—'}</p>
          <p className="text-xs text-slate-400">{roleLabel(role)}</p>
        </div>
      )}

      {/* Nav items */}
      <div className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
        {items.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={sidebarCollapsed ? label : undefined}
            className={({ isActive }) =>
              `flex items-center py-2.5 rounded-xl text-sm font-medium transition-colors ` +
              (sidebarCollapsed ? 'justify-center px-0' : 'gap-3 px-3') + ' ' +
              (isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900')
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            {!sidebarCollapsed && label}
          </NavLink>
        ))}
      </div>

      {/* Sign out + version */}
      <div className="p-2 border-t border-slate-100 shrink-0">
        <button
          onClick={signOut}
          title={sidebarCollapsed ? 'Sign Out' : undefined}
          className={`flex items-center w-full rounded-xl text-sm font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors py-2.5 ${sidebarCollapsed ? 'justify-center px-0' : 'gap-3 px-3'}`}
        >
          <LogOut className="w-4 h-4 shrink-0" />
          {!sidebarCollapsed && 'Sign Out'}
        </button>
        {!sidebarCollapsed && (
          <div className="flex justify-center mt-1 pb-1">
            <VersionChip className="text-[10px] font-medium text-slate-400" />
          </div>
        )}
      </div>
    </nav>
  );
}
