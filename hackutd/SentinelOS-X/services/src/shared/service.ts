// Common lifecycle for SentinelOS X background services (telemetry generator,
// Nemotron investigator). Each service is its own SpacetimeDB identity: it
// announces itself, then waits until an Incident Commander authorizes it in
// System Settings. Every write it makes is checked server-side.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Identity } from 'spacetimedb';
import { DbConnection, tables } from '../module_bindings/index';

export type ServiceKind = 'telemetry' | 'ai_agent';
export type AuthState = 'unknown' | 'pending' | 'authorized' | 'revoked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = join(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function tokenPath(slug: string) {
  return join(ROOT, '.tokens', `${slug}.token`);
}

export function log(prefix: string, ...args: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), `[${prefix}]`, ...args);
}

export interface ServiceContext {
  conn: DbConnection;
  identity: Identity;
  authState(): AuthState;
}

type SubscribableTable = (typeof tables)[keyof typeof tables];

export function startService(opts: {
  slug: string;
  name: string;
  kind: ServiceKind;
  subscribe: SubscribableTable[];
  onReady: (ctx: ServiceContext) => void;
  onAuthChange?: (state: AuthState) => void;
}): void {
  const host = env('SPACETIMEDB_HOST', 'ws://localhost:3000');
  const db = env('SPACETIMEDB_DB_NAME', 'sentinelos-x');
  const tp = tokenPath(opts.slug);
  const savedToken = existsSync(tp) ? readFileSync(tp, 'utf8').trim() : undefined;
  let subscribed = false;
  let ready = false;
  let lastState: AuthState = 'unknown';
  let identity: Identity | undefined;

  const authState = (conn: DbConnection): AuthState => {
    if (!identity) return 'unknown';
    const hex = identity.toHexString();
    const sp = [...conn.db.servicePrincipal.iter()].find(s => s.identity.toHexString() === hex);
    return (sp?.status as AuthState | undefined) ?? 'unknown';
  };

  const watchAuth = (conn: DbConnection) => {
    const s = authState(conn);
    if (s === lastState) return;
    lastState = s;
    if (s === 'pending') log(opts.slug, `Awaiting authorization: open SentinelOS X → System Settings → Services and authorize "${opts.name}".`);
    if (s === 'authorized') log(opts.slug, 'Authorized by an Incident Commander.');
    if (s === 'revoked') log(opts.slug, 'Authorization revoked — writes will be rejected by the server.');
    opts.onAuthChange?.(s);
  };

  let everConnected = false;
  const connect = () => {
  log(opts.slug, `Connecting to ${host} / ${db}`);
  DbConnection.builder()
    .withUri(host)
    .withDatabaseName(db)
    .withToken(savedToken)
    .withAutomaticReconnect()
    .onConnect((conn, id, token) => {
      everConnected = true;
      identity = id;
      mkdirSync(dirname(tp), { recursive: true });
      writeFileSync(tp, token, { mode: 0o600 });
      log(opts.slug, `Connected as ${id.toHexString().slice(0, 16)}…`);
      if (subscribed) return; // SDK replays the subscription after reconnects
      subscribed = true;
      conn.db.servicePrincipal.onInsert(() => watchAuth(conn));
      conn.db.servicePrincipal.onUpdate(() => watchAuth(conn));
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          if (ready) return;
          ready = true;
          conn.reducers
            .announceService({ name: opts.name, kind: opts.kind })
            .then(() => {
              watchAuth(conn);
              opts.onReady({ conn, identity: id, authState: () => authState(conn) });
            })
            .catch(err => {
              log(opts.slug, 'Could not register service:', err instanceof Error ? err.message : err);
              process.exitCode = 1;
            });
        })
        .onError(ctx => log(opts.slug, 'Subscription error:', ctx.event?.message ?? 'unknown'))
        .subscribe([tables.servicePrincipal, ...opts.subscribe]);
    })
    .onDisconnect((_ctx, err, nextAttempt, delayMs) => {
      log(opts.slug, `Disconnected${err ? `: ${err.message}` : ''}${nextAttempt !== undefined ? ` — reconnect attempt ${nextAttempt} in ${delayMs} ms` : ''}`);
    })
    .onConnectError((_ctx, err, nextAttempt) => {
      log(opts.slug, `Connection error: ${err.message}. Is \`spacetime start\` running and the module published?`);
      // The SDK retries dropped connections itself, but not a failed *initial*
      // connection; keep trying so services can start before the server.
      if (!everConnected && nextAttempt === undefined) setTimeout(connect, 5000);
    })
    .build();
  };
  connect();
}
