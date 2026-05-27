import { QuickEntry } from './QuickEntry';
import { TodayLog } from './TodayLog';

export function EntryWithLog() {
  return (
    <>
      {/* Mobile: just the entry form; Today is accessible via bottom nav */}
      <div className="lg:hidden">
        <QuickEntry />
      </div>

      {/* Desktop: full-height split view */}
      <div className="hidden lg:flex w-full" style={{ height: 'calc(100vh - 56px)' }}>
        {/* Left panel — Quick Entry form (narrower to give Today's Log more room) */}
        <div className="relative w-[280px] shrink-0 border-r border-slate-100">
          <div className="h-full overflow-y-auto bg-white">
            <QuickEntry panelMode />
          </div>
          {/* Scroll hint gradient */}
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-white to-transparent" />
        </div>

        {/* Right panel — Today's Log, fills all remaining space */}
        <div className="flex-1 overflow-y-auto bg-slate-50">
          <TodayLog panelMode />
        </div>
      </div>
    </>
  );
}
