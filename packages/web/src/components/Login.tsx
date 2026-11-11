import { KeyRound, LogIn } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useApp } from '../lib/store';
import { BrandMark } from './Brand';
import { Button, Field } from './ui';

export function Login() {
  const signIn = useApp((s) => s.signIn);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(login.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <div className="login__brand">
          <BrandMark size={36} />
          <div>
            <h1>Battleground</h1>
            <p className="muted">Portable cyber ranges, Ludus compatible</p>
          </div>
        </div>
        <Field label="Email or user ID" htmlFor="login-id">
          <input id="login-id" className="input" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus required />
        </Field>
        <Field label="Password" htmlFor="login-password">
          <input id="login-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error ? (
          <div className="callout callout--err" role="alert">
            <KeyRound />
            <span>{error}</span>
          </div>
        ) : null}
        <Button type="submit" variant="primary" block busy={busy}>
          <LogIn />
          Sign in
        </Button>
        <p className="faint text-sm">
          First time? The admin password and API key were printed in the server's output when it started. You can reset them with{' '}
          <code>battleground reset-admin</code>.
        </p>
      </form>
    </div>
  );
}
