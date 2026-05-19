import { useAuth } from '../../context/AuthContext';

export function TopBar() {
  const { profile, role, signOut } = useAuth();

  return (
    <header className="fixed top-0 left-0 right-0 z-30 bg-white border-b border-slate-100">
      <div className="flex items-center justify-between lg:pl-60">
        {/* Brand — centered on mobile, left-aligned content area on desktop */}
        <div className="flex-1 flex flex-col items-center justify-center py-2.5 lg:items-start lg:pl-6">
          <span className="tk-wordmark text-[13px] text-slate-900 leading-none">Time Keeper</span>
          <span className="tk-sub text-[8px] text-slate-400 mt-1 leading-none">Est. 2018</span>
        </div>

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
