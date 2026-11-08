// SpacetimeDB connection configuration. The connection itself is owned by
// SpacetimeDBProvider (one per app), which also handles automatic reconnects.
import { DbConnection } from '../module_bindings';

export const SPACETIMEDB_HOST: string = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000';
export const SPACETIMEDB_DB_NAME: string = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'sentinelos-x';

// The auth token is kept in sessionStorage (per browser tab) on purpose: each
// tab becomes its own SpacetimeDB identity, so two tabs can act as two
// different responders in the demo. A refresh keeps the same identity.
const TOKEN_KEY = `${SPACETIMEDB_HOST}/${SPACETIMEDB_DB_NAME}/auth_token`;

function readToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeToken(token: string) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable: identity will not survive a refresh */
  }
}

export function clearIdentity() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function createConnectionBuilder() {
  return DbConnection.builder()
    .withUri(SPACETIMEDB_HOST)
    .withDatabaseName(SPACETIMEDB_DB_NAME)
    .withToken(readToken())
    .onConnect((_conn, _identity, token) => writeToken(token))
    .onConnectError((_ctx, err) => {
      console.error('SpacetimeDB connection error', err);
    });
}
