import { NavLink, useNavigate } from 'react-router-dom';
import { PlusCircle, ClipboardList, Bell, BarChart2, Settings } from 'lucide-react';
import { useAppStore } from '../../store';

const tabs = [
  { to: '/',          icon: PlusCircle,    label: 'Entry'    },
  { to: '/today',     icon: ClipboardList, label: 'Today'    },
  { to: '/followups', icon: Bell,          label: 'Follow-ups' },
  { to: '/manager',   icon: BarChart2,     label: 'Manager', protected: true },
  { to: '/settings',  icon: Settings,      label: 'Settings', protected: true },
];

export function NavBar() {
  const { isManagerAuthed } = useAppStore();
  const navigate = useNavigate();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-slate-100 safe-area-bottom">
      <div className="flex items-center justify-around px-2 py-1">
        {tabs.map(({ to, icon: Icon, label, protected: prot }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            onClick={(e) => {
              if (prot && !isManagerAuthed) {
                e.preventDefault();
                navigate('/manager-login', { state: { returnTo: to } });
              }
            }}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 px-3 py-2 rounded-2xl transition-all duration-150 min-w-[56px] touch-manipulation ` +
              (isActive
                ? 'text-brand-700 bg-brand-50'
                : 'text-slate-400 hover:text-slate-600')
            }
          >
            <Icon className="w-5 h-5" />
            <span className="text-[10px] font-semibold leading-none">{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
