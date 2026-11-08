// Invoke a reducer and report the server's verdict. Success is only shown after
// the server confirms the transaction committed; SenderError messages from the
// module (validation, authorization) are surfaced verbatim.
import { useCallback, useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import type { DbConnection } from '../module_bindings';
import { useToast } from '../components/Toast';

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

export function useAction() {
  const { getConnection, isActive } = useSpacetimeDB();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(
    async (key: string, call: (conn: DbConnection) => Promise<void>, successText?: string): Promise<boolean> => {
      const conn = getConnection() as DbConnection | null;
      if (!conn || !isActive) {
        toast('error', 'Not connected to SpacetimeDB — action not sent.');
        return false;
      }
      setPending(key);
      try {
        await call(conn);
        if (successText) toast('success', successText);
        return true;
      } catch (err) {
        toast('error', errorMessage(err));
        return false;
      } finally {
        setPending(p => (p === key ? null : p));
      }
    },
    [getConnection, isActive, toast]
  );

  return { run, pending, connected: isActive };
}
