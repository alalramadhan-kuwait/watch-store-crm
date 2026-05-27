import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const fullEmail = email.includes('@') ? email : `${email}@time-keeper.com`;
    const { error } = await signIn(fullEmail, password);
    if (error) {
      setError('Incorrect username or password.');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left panel — brand (desktop only) */}
      <div className="hidden lg:flex lg:w-[480px] xl:w-[560px] flex-col justify-between bg-[#0a0a0a] px-14 py-12 shrink-0">
        <div>
          {/* TK monogram — text mark on dark */}
          <p className="text-white font-light text-4xl tracking-[0.15em] leading-none" style={{ fontFamily: "'Josefin Sans', sans-serif" }}>tk</p>
        </div>
        <div>
          <p className="tk-wordmark text-white text-xl tracking-[0.3em] leading-none">TIME KEEPER</p>
          <p className="tk-sub text-slate-400 text-xs tracking-[0.2em] mt-2">EST. 2018</p>
          <div className="w-10 h-px bg-teal-600 mt-6 mb-6" />
          <p className="text-slate-400 text-sm leading-relaxed max-w-xs">
            Watch Store Operations System.<br />
            Sales · Follow-ups · Reports · Analytics.
          </p>
        </div>
        <p className="text-slate-600 text-xs">Secure staff portal</p>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex flex-col items-center justify-center bg-white px-6 py-12">
        {/* Mobile brand */}
        <div className="lg:hidden flex flex-col items-center mb-10">
          <img
            src={`${import.meta.env.BASE_URL}tk-logo.png`}
            alt="TIME KEEPER"
            className="w-32 h-32 object-contain"
          />
          <p className="tk-sub text-[10px] text-slate-400 tracking-widest mt-2">Staff Portal</p>
        </div>

        <div className="w-full max-w-sm">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-slate-900">Sign in</h1>
            <p className="text-slate-500 text-sm mt-1">TIME KEEPER Operations System</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Username</label>
              <input
                type="text"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="staff or manager"
                className="input"
                autoFocus
                autoComplete="username"
              />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••"
                className="input"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p className="text-rose-600 text-sm font-medium">{error}</p>
            )}

            <button
              type="submit"
              disabled={!email || !password || loading}
              className="btn-primary w-full py-3 disabled:opacity-40"
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <p className="text-center text-xs text-slate-400 mt-8">
            Contact your manager to reset your password.
          </p>
        </div>
      </div>
    </div>
  );
}
