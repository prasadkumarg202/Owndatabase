'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, tokens } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ErrorBox } from '@/components/ui/Card';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email)) return setError('Please enter a valid email');
    if (mode === 'signup' && password.length < 8) return setError('Password must be at least 8 characters');
    setLoading(true);
    try {
      if (mode === 'signup') await api.post('/auth/signup', { email, password, name: name || undefined });
      const r = await api.post('/auth/login', { email, password });
      tokens.set(r.access_token, r.refresh_token);
      const next = params.get('next');
      router.replace(next && next.startsWith('/') ? next : '/dashboard');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h1 className="text-lg font-semibold text-gray-900">{mode === 'login' ? 'Sign in to your account' : 'Create your account'}</h1>
      <ErrorBox error={error ? new Error(error) : null} />
      {mode === 'signup' && <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
      <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" required />
      <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required
        hint={mode === 'signup' ? 'At least 8 characters' : undefined} />
      <Button type="submit" loading={loading} className="w-full">{mode === 'login' ? 'Sign in' : 'Create account'}</Button>
      <p className="text-center text-sm text-gray-500">
        {mode === 'login' ? 'New here? ' : 'Already have an account? '}
        <button type="button" className="font-medium text-blue-600 hover:underline" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}>
          {mode === 'login' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
    </form>
  );
}
