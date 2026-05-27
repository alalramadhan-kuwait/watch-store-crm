import { useEffect, useState } from 'react';
import { Store } from 'lucide-react';
import { getSettings } from '../db';
import { useAppStore } from '../store';

/**
 * Full-screen overlay shown to staff users at the start of each session
 * so they can choose which outlet they're working at today.
 * Stores the choice in sessionStorage (clears when the browser tab closes).
 */
export function OutletSelector({ onSelected }: { onSelected: () => void }) {
  const { setActiveOutlet } = useAppStore();
  const [outlets, setOutlets] = useState<string[]>(['Avenues', 'TimeGallery']);

  useEffect(() => {
    getSettings().then(s => {
      if (s.outlets?.length) setOutlets(s.outlets);
    });
  }, []);

  function pick(outlet: string) {
    setActiveOutlet(outlet);
    onSelected();
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-10">
          <img
            src={`${import.meta.env.BASE_URL}tk-logo.png`}
            alt="TIME KEEPER"
            className="w-16 h-16 object-contain mb-4"
          />
          <h1 className="text-xl font-bold text-slate-900">Which outlet are you at?</h1>
          <p className="text-sm text-slate-400 mt-1">Choose your location to start logging</p>
        </div>

        {/* Outlet buttons */}
        <div className="space-y-3">
          {outlets.map(outlet => (
            <button
              key={outlet}
              onClick={() => pick(outlet)}
              className="w-full flex items-center gap-4 p-5 bg-white border-2 border-slate-200 rounded-2xl hover:border-brand-700 hover:bg-brand-50 active:scale-[0.98] transition-all duration-150 text-left group"
            >
              <div className="w-10 h-10 rounded-xl bg-brand-50 group-hover:bg-brand-100 flex items-center justify-center shrink-0 transition-colors">
                <Store className="w-5 h-5 text-brand-700" />
              </div>
              <div>
                <p className="font-bold text-slate-900 text-base">{outlet}</p>
                <p className="text-xs text-slate-400 mt-0.5">Tap to select this outlet</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
