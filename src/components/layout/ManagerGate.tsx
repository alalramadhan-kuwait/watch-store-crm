import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { getSettings } from '../../db';
import { useAppStore } from '../../store';

export function ManagerLogin() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { setManagerAuthed } = useAppStore();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = (location.state as { returnTo?: string })?.returnTo || '/manager';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const settings = await getSettings();
      if (pin === settings.managerPin) {
        setManagerAuthed(true);
        navigate(returnTo);
      } else {
        setError('Incorrect PIN. Try again.');
        setPin('');
      }
    } finally {
      setLoading(false);
    }
  }

  function handlePad(digit: string) {
    if (pin.length < 6) setPin(p => p + digit);
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-6 pb-20">
      <div className="w-full max-w-xs">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-brand-700 rounded-3xl flex items-center justify-center mb-4 shadow-lg shadow-brand-700/25">
            <Lock className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Manager Access</h1>
          <p className="text-slate-500 text-sm mt-1">Enter your PIN to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="card p-6">
          {/* PIN dots */}
          <div className="flex justify-center gap-3 mb-6">
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div
                key={i}
                className={`w-3.5 h-3.5 rounded-full border-2 transition-all duration-150 ${
                  i < pin.length
                    ? 'bg-brand-700 border-brand-700 scale-110'
                    : 'border-slate-300'
                }`}
              />
            ))}
          </div>

          {/* Hidden input for keyboard entry */}
          <input
            type="password"
            value={pin}
            onChange={e => setPin(e.target.value.slice(0, 6))}
            className="sr-only"
            autoFocus
          />

          {/* Numpad */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((d, i) => (
              <button
                key={i}
                type="button"
                onClick={() => d === '⌫' ? setPin(p => p.slice(0, -1)) : d ? handlePad(d) : null}
                disabled={!d && d !== '0'}
                className={`h-14 rounded-2xl text-xl font-semibold transition-all duration-100 active:scale-90 touch-manipulation
                  ${d === '⌫' ? 'text-slate-500 bg-slate-100' : d ? 'bg-slate-100 text-slate-800 hover:bg-slate-200' : 'invisible'}`}
              >
                {d}
              </button>
            ))}
          </div>

          {error && (
            <p className="text-rose-600 text-sm text-center mb-3 font-medium">{error}</p>
          )}

          <button
            type="submit"
            disabled={pin.length < 4 || loading}
            className="btn-primary w-full disabled:opacity-40"
          >
            {loading ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}
