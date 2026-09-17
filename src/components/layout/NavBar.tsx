import { NavLink } from 'react-router-dom';
import { PlusCircle, ClipboardList, Bell, UserRound, Home, Users, MoreHorizontal } from 'lucide-react';
import { useAuth, canSeePerformance } from '../../context/AuthContext';

/**
 * Five tabs, whoever is holding the phone.
 *
 * It used to be four for a salesperson, six for a manager and **eight** for an
 * owner, because every capability added a tab. Eight targets across a phone is
 * about 45px each — smaller than a fingertip — and the ones that mattered were
 * no easier to find than the ones that did not.
 *
 * The two roles want different things, so they get different tabs rather than a
 * shared compromise. A salesperson's day is entry and follow-ups; a manager's
 * is the shop and the team, with entry still one tap away because he sells too.
 * Everything that is opened once a day rather than between customers moved
 * behind More.
 */
const salesTabs = [
  { to: '/entry',     icon: PlusCircle,      label: 'Entry'      },
  { to: '/today',     icon: ClipboardList,   label: 'Today'      },
  { to: '/followups', icon: Bell,            label: 'Follow-ups' },
  { to: '/portal',    icon: UserRound,       label: 'Me'         },
];

const managerTabs = [
  { to: '/',          icon: Home,            label: 'Home'       },
  { to: '/entry',     icon: PlusCircle,      label: 'Entry'      },
  { to: '/team',      icon: Users,           label: 'Team'       },
  { to: '/followups', icon: Bell,            label: 'Follow-ups' },
  { to: '/more',      icon: MoreHorizontal,  label: 'More'       },
];

export function NavBar() {
  const { role } = useAuth();
  const items = canSeePerformance(role) ? managerTabs : salesTabs;

  return (
    // Hidden on desktop — sidebar takes over
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-slate-100 safe-area-bottom safe-area-x lg:hidden">
      <div className="flex items-center justify-around px-1 py-1">
        {items.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 px-2 py-2 rounded-2xl transition-all duration-150 flex-1 min-w-0 touch-manipulation ` +
              (isActive ? 'text-brand-700 bg-brand-50' : 'text-slate-400 hover:text-slate-600')
            }
          >
            <Icon className="w-5 h-5 shrink-0" />
            <span className="text-[10px] font-semibold leading-none truncate max-w-full">{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
