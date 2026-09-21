import { Link } from 'react-router-dom';
import {
  ClipboardList, BarChart2, FileText, Users, Users2, UserRound, Settings as Cog, ChevronRight, LogOut, PlusCircle,
} from 'lucide-react';
import { useAuth, canSeePerformance } from '../context/AuthContext';

/**
 * Everything that matters but not every hour.
 *
 * The bottom bar carried eight items for an owner, which is four more than a
 * thumb can aim at. What moved here is what gets opened once a day or once a
 * week — the month's dashboard, the reports, the CRM, settings — rather than
 * what gets opened between customers.
 */
export function More() {
  const { profile, role, signOut } = useAuth();
  const perf = canSeePerformance(role);

  const groups: { title: string; items: { to: string; icon: typeof FileText; label: string; hint: string; show: boolean }[] }[] = [
    {
      title: 'The shop',
      items: [
        { to: '/entry', icon: PlusCircle, label: 'Log a visit', hint: 'A customer who is here now', show: true },
        { to: '/today', icon: ClipboardList, label: 'Today’s log', hint: 'Every visit, and Close Day', show: true },
        { to: '/team', icon: Users2, label: 'Team', hint: 'Who is in, requests, attendance', show: perf },
        { to: '/manager', icon: BarChart2, label: 'Monthly dashboard', hint: 'The month, by person and by brand', show: perf },
        { to: '/reports', icon: FileText, label: 'Reports', hint: 'Daily reports to send on', show: perf },
        { to: '/crm', icon: Users, label: 'Customers', hint: 'Who they are, their history, follow-ups', show: true },
      ],
    },
    {
      title: 'You',
      items: [
        { to: '/portal', icon: UserRound, label: 'My Portal', hint: 'Clock in, leave, attendance, corrections', show: true },
      ],
    },
    {
      title: 'Admin',
      items: [
        { to: '/settings', icon: Cog, label: 'Settings', hint: 'Outlets, roster, brands', show: role === 'admin' },
      ],
    },
  ];

  return (
    <div className="p-4 pb-28 space-y-5 max-w-2xl mx-auto">
      <div>
        <h1 className="text-lg font-bold text-slate-900">{profile?.full_name ?? 'More'}</h1>
        <p className="text-xs text-slate-400 capitalize">{role ?? ''}</p>
      </div>

      {groups.map((g) => {
        const items = g.items.filter((i) => i.show);
        if (!items.length) return null;
        return (
          <div key={g.title}>
            <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400 mb-2">{g.title}</p>
            <div className="card divide-y divide-slate-100 overflow-hidden">
              {items.map(({ to, icon: Icon, label, hint }) => (
                <Link key={to} to={to} className="flex items-center gap-3 px-4 py-3.5 active:bg-slate-50">
                  <Icon className="w-5 h-5 text-slate-400 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold text-slate-800 text-sm">{label}</span>
                    <span className="block text-xs text-slate-400 truncate">{hint}</span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
                </Link>
              ))}
            </div>
          </div>
        );
      })}

      <button onClick={() => void signOut()}
        className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl border-2 border-slate-200 text-slate-600 font-semibold text-sm active:scale-[0.99]">
        <LogOut className="w-4 h-4" /> Sign out
      </button>
    </div>
  );
}
