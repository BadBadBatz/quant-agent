'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase-auth';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const supabase = createSupabaseBrowserClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      setError('Invalid credentials.');
      setLoading(false);
    } else {
      router.push('/');
      router.refresh();
    }
  }

  return (
    <div className="min-h-screen bg-[#080808] flex items-center justify-center">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="mb-8 text-center">
          <p className="font-mono text-xs text-[#444] uppercase tracking-[0.3em] mb-3">
            AUTONOMOUS TRADING SYSTEM
          </p>
          <h1 className="font-mono text-2xl font-semibold text-white tracking-widest">
            QUANT AGENT
          </h1>
          <div className="mt-3 flex items-center justify-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-[#00d97e] animate-pulse" />
            <span className="font-mono text-xs text-[#00d97e]">PAPER MODE</span>
          </div>
        </div>

        {/* Login card */}
        <form
          onSubmit={handleSubmit}
          className="bg-[#0d0d0d] border border-[#1e1e1e] rounded p-6 space-y-4"
        >
          <div>
            <label className="block text-xs font-mono text-[#555] uppercase tracking-wider mb-1.5">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full bg-[#080808] border border-[#1e1e1e] rounded px-3 py-2 font-mono text-sm text-[#e8e8e8] placeholder-[#333] focus:outline-none focus:border-[#2a2a2a] transition-colors"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block text-xs font-mono text-[#555] uppercase tracking-wider mb-1.5">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full bg-[#080808] border border-[#1e1e1e] rounded px-3 py-2 font-mono text-sm text-[#e8e8e8] placeholder-[#333] focus:outline-none focus:border-[#2a2a2a] transition-colors"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="font-mono text-xs text-[#ff4444] border border-[#ff444433] rounded px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-white text-black font-mono text-sm font-semibold rounded hover:bg-[#e8e8e8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'AUTHENTICATING...' : 'SIGN IN'}
          </button>
        </form>

        <p className="text-center text-[#333] text-xs font-mono mt-6">
          ACCESS RESTRICTED
        </p>
      </div>
    </div>
  );
}
