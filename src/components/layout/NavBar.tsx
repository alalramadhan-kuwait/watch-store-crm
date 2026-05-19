import { NavLink } from 'react-router-dom';
import { PlusCircle, ClipboardList, Bell, BarChart2, Settings } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const baseItems = [
  { to: '/',          icon: PlusCircle,    label: 'Entry'      },
  { to: '/today',     icon: ClipboardList, label: 'Today'      },
  { to: '/followups', icon: Bell,          label: 'Follow-ups' },
];

const adminItems = [
  { to: '/manager',  icon: BarChart2, label: 'Manager'  },
  { to: '/settings', icon: Settings,  label: 'Settings' },
];

export function NavBar() {
  const { role } = useAuth();
  const items = role === 'admin' ? [...baseItems, ...adminItems] : baseItems;

  return (
    // Hidden on desktop — sidebar takes over
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-slate-100 safe-area-bottom lg:hidden">
      <div className="flex items-center justify-around px-2 py-1">
        {items.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 px-3 py-2 rounded-2xl transition-all duration-150 min-w-[48px] touch-manipulation ` +
              (isActive ? 'text-brand-700 bg-brand-50' : 'text-slate-400 hover:text-slate-600')
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
