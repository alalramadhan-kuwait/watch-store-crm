import { useState } from 'react';
import { getSettings } from '../../db';
import { useAppStore } from '../../store';

export function StaffGate({ children }: { children: React.ReactNode }) {
  const { isStaffAuthed, setStaffAuthed } = useAppStore();

  if (isStaffAuthed) return <>{children}</>;
  return <StaffLogin onSuccess={() => setStaffAuthed(true)} />;
}

function StaffLogin({ onSuccess }: { onSuccess: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const settings = await getSettings();
      if (pin === settings.staffPin) {
        onSuccess();
      } else {
        setError('Incorrect access code.');
        setPin('');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6 pb-20">
      <div className="w-full max-w-xs">
        <div className="flex flex-col items-center mb-10">
          <img
            src={`${import.meta.env.BASE_URL}tk-logo.png`}
            alt="TIME KEEPER"
            className="w-44 h-44 object-contain"
          />
          <p className="tk-sub text-[10px] text-slate-400 tracking-widest mt-1">Staff Access</p>
          <div className="w-8 h-px bg-slate-200 mt-3" />
        </div>

        <form onSubmit={handleSubmit} className="card p-6 space-y-4">
          <div>
            <label className="label">Access Code</label>
            <input
              type="password"
              value={pin}
              onChange={e => setPin(e.target.value)}
              placeholder="Enter code"
              className="input text-center tracking-widest text-lg"
              autoFocus
              autoComplete="off"
            />
          </div>

          {error && (
            <p className="text-rose-600 text-sm text-center font-medium">{error}</p>
          )}

          <button
            type="submit"
            disabled={pin.length < 1 || loading}
            className="btn-primary w-full disabled:opacity-40"
          >
            {loading ? 'Checking…' : 'Enter'}
          </button>
        </form>

        <p className="text-center text-xs text-slate-400 mt-6">
          TIME KEEPER — Staff Portal
        </p>
      </div>
    </div>
  );
}
