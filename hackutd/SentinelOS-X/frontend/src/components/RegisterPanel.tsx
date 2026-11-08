import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useAction } from '../hooks/useAction';
import { useSentinel } from '../hooks/useSentinelData';

export function RegisterPanel() {
  const { responders } = useSentinel();
  const { run, pending } = useAction();
  const [name, setName] = useState('');
  const firstUser = !responders.some(r => r.role === 'incident_commander');

  return (
    <form
      className="panel flex flex-wrap items-end gap-3 border-cyan-500/30 p-4"
      onSubmit={e => {
        e.preventDefault();
        void run('register', c => c.reducers.registerResponder({ displayName: name }), 'Registered as responder');
      }}
    >
      <div className="min-w-60 flex-1">
        <label htmlFor="reg-name" className="text-sm font-medium text-slate-100">
          Join the response team
        </label>
        <p className="mb-2 text-xs text-slate-400">
          Your browser tab has a SpacetimeDB identity but no responder profile yet.{' '}
          {firstUser ? 'As the first responder you will become Incident Commander.' : 'New responders start as Observers.'}
        </p>
        <input id="reg-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Display name" minLength={2} maxLength={40} required />
      </div>
      <button className="btn-primary" disabled={pending === 'register' || name.trim().length < 2}>
        <UserPlus className="size-4" aria-hidden /> Register
      </button>
    </form>
  );
}
