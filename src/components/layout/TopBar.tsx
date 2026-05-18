export function TopBar() {
  return (
    <header className="fixed top-0 left-0 right-0 z-30 bg-white border-b border-slate-100">
      <div className="flex flex-col items-center justify-center py-2.5">
        <span className="tk-wordmark text-[13px] text-slate-900 leading-none">Time Keeper</span>
        <span className="tk-sub text-[8px] text-slate-400 mt-1 leading-none">Est. 2018</span>
      </div>
    </header>
  );
}
