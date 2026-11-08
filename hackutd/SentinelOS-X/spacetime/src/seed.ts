// Synthetic demonstration infrastructure. Inserted into SpacetimeDB by the
// `init` lifecycle reducer (and restorable via reset_demo_environment); the
// frontend only ever reads it back through subscriptions.
//
// Edge A -> B means "A requires B to provide its intended service".
import type { Criticality, DependencyType, EffectKind } from './propagation';

export interface SeedAsset {
  assetId: string;
  name: string;
  assetType: string;
  environment: string;
  criticality: Criticality;
  description: string;
}

export interface SeedEdge {
  dependent: string;
  required: string;
  type: DependencyType;
  rationale: string;
}

export const SEED_ASSETS: readonly SeedAsset[] = [
  { assetId: 'customer-portal', name: 'Customer Portal', assetType: 'web_application', environment: 'production-dmz', criticality: 'high', description: 'Public web front end used by customers.' },
  { assetId: 'ext-gateway', name: 'External Gateway', assetType: 'network_edge', environment: 'production-dmz', criticality: 'high', description: 'Edge load balancer / reverse proxy terminating TLS for public traffic.' },
  { assetId: 'app-api', name: 'Application API', assetType: 'service', environment: 'production-core', criticality: 'mission_critical', description: 'Core business API serving the portal and partner integrations.' },
  { assetId: 'auth-svc', name: 'Authentication Service', assetType: 'identity', environment: 'production-core', criticality: 'mission_critical', description: 'Issues and validates session tokens.' },
  { assetId: 'primary-db', name: 'Primary Database', assetType: 'database', environment: 'production-data', criticality: 'mission_critical', description: 'Transactional database for accounts, sessions and orders.' },
  { assetId: 'file-storage', name: 'File Storage', assetType: 'storage', environment: 'production-data', criticality: 'high', description: 'Document and upload object store.' },
  { assetId: 'monitoring-svc', name: 'Monitoring Service', assetType: 'observability', environment: 'operations', criticality: 'medium', description: 'Metrics, alerting and dashboards for operations staff.' },
  { assetId: 'telemetry-gw', name: 'Telemetry Ingestion Gateway', assetType: 'ingestion', environment: 'operations', criticality: 'medium', description: 'Receives metrics and log streams for monitoring.' },
  { assetId: 'log-shipper', name: 'Log Shipping Agent', assetType: 'log_pipeline', environment: 'operations', criticality: 'low', description: 'Collects and forwards application and audit logs to telemetry ingestion.' },
  { assetId: 'backup-svc', name: 'Backup Service', assetType: 'backup', environment: 'recovery', criticality: 'high', description: 'Snapshot orchestration and restore tooling.' },
  { assetId: 'backup-vault', name: 'Offsite Backup Vault', assetType: 'storage', environment: 'recovery-offsite', criticality: 'high', description: 'Immutable, separately administered backup storage.' },
];

export const SEED_EDGES: readonly SeedEdge[] = [
  { dependent: 'customer-portal', required: 'ext-gateway', type: 'required', rationale: 'All public traffic reaches the portal through the gateway.' },
  { dependent: 'customer-portal', required: 'app-api', type: 'required', rationale: 'Portal pages are rendered from API data.' },
  { dependent: 'app-api', required: 'auth-svc', type: 'required', rationale: 'Every API call validates a session token.' },
  { dependent: 'app-api', required: 'primary-db', type: 'required', rationale: 'API reads and writes transactional records.' },
  { dependent: 'app-api', required: 'file-storage', type: 'noncritical', rationale: 'Document upload/download features fail; core flows continue.' },
  { dependent: 'app-api', required: 'monitoring-svc', type: 'optional', rationale: 'Metrics export is best-effort.' },
  { dependent: 'auth-svc', required: 'primary-db', type: 'required', rationale: 'User credentials and sessions are stored in the primary database.' },
  { dependent: 'monitoring-svc', required: 'telemetry-gw', type: 'required', rationale: 'Monitoring has no data without ingestion.' },
  { dependent: 'log-shipper', required: 'telemetry-gw', type: 'noncritical', rationale: 'Shipper buffers logs locally while ingestion is down.' },
  { dependent: 'backup-svc', required: 'backup-vault', type: 'required', rationale: 'Restores read only from the independent offsite vault.' },
  { dependent: 'backup-svc', required: 'monitoring-svc', type: 'optional', rationale: 'Job status reporting is best-effort.' },
];

// Phase 2 services, inserted idempotently into new AND existing databases.
// Kept separate so the Phase 1 core topology above stays stable for its consumers.
export const PHASE2_SEED_ASSETS: readonly SeedAsset[] = [
  { assetId: 'message-queue', name: 'Message Queue', assetType: 'messaging', environment: 'production-core', criticality: 'high', description: 'Durable event bus for asynchronous jobs (orders, receipts, notifications).' },
  { assetId: 'payment-svc', name: 'Payment Service', assetType: 'service', environment: 'production-core', criticality: 'mission_critical', description: 'Authorizes and settles customer payments.' },
  { assetId: 'notification-svc', name: 'Notification Service', assetType: 'service', environment: 'production-core', criticality: 'medium', description: 'Sends e-mail and push notifications from queued events.' },
  { assetId: 'admin-portal', name: 'Internal Admin Portal', assetType: 'web_application', environment: 'internal', criticality: 'high', description: 'Staff back-office for account and order administration (not internet-facing).' },
  { assetId: 'analytics-svc', name: 'Analytics Service', assetType: 'analytics', environment: 'production-data', criticality: 'low', description: 'Business reporting from event streams and database replicas.' },
];

export const PHASE2_SEED_EDGES: readonly SeedEdge[] = [
  { dependent: 'app-api', required: 'payment-svc', type: 'noncritical', rationale: 'Checkout fails without payments; browsing and accounts continue.' },
  { dependent: 'app-api', required: 'message-queue', type: 'noncritical', rationale: 'Async jobs are delayed; synchronous requests continue.' },
  { dependent: 'payment-svc', required: 'auth-svc', type: 'required', rationale: 'Every payment is tied to an authenticated session.' },
  { dependent: 'payment-svc', required: 'primary-db', type: 'required', rationale: 'Orders and ledgers live in the primary database.' },
  { dependent: 'payment-svc', required: 'message-queue', type: 'noncritical', rationale: 'Receipts are published asynchronously.' },
  { dependent: 'notification-svc', required: 'message-queue', type: 'required', rationale: 'Notifications are driven entirely by queued events.' },
  { dependent: 'admin-portal', required: 'auth-svc', type: 'required', rationale: 'Staff sign in through the authentication service.' },
  { dependent: 'admin-portal', required: 'app-api', type: 'required', rationale: 'Back-office screens call the application API.' },
  { dependent: 'analytics-svc', required: 'message-queue', type: 'required', rationale: 'Analytics consumes the event stream.' },
  { dependent: 'analytics-svc', required: 'primary-db', type: 'noncritical', rationale: 'Historical reports read a replica; live dashboards continue.' },
];

/** Full demo environment seeded by the module (16 services). */
export const DEMO_ASSETS: readonly SeedAsset[] = [...SEED_ASSETS, ...PHASE2_SEED_ASSETS];
export const DEMO_EDGES: readonly SeedEdge[] = [...SEED_EDGES, ...PHASE2_SEED_EDGES];

export const RANSOMWARE_SCENARIO = {
  scenarioType: 'simulated_ransomware',
  initialAssetId: 'primary-db',
  defaultTitle: 'Simulated ransomware disruption — Primary Database',
  description:
    'SIMULATION: synthetic training scenario. The primary database host is modeled as encrypted by ransomware and taken offline. No real systems are affected.',
} as const;

// ─────────────────────── Phase 2 scenarios ───────────────────────
// Every scenario is a defensive training exercise on synthetic rows only.
// Evidence uses reserved documentation IP ranges (RFC 5737) and fake accounts.

export interface ScenarioDef {
  scenarioType: string;
  label: string;
  initialAssetId: string;
  effectKind: EffectKind;
  effectLevel: 'offline' | 'degraded';
  defaultTitle: string;
  description: string;
  recoveryPlan: string;
}

export const SCENARIOS: readonly ScenarioDef[] = [
  {
    scenarioType: 'auth_compromise',
    label: 'Authentication compromise',
    initialAssetId: 'auth-svc',
    effectKind: 'compromise',
    effectLevel: 'degraded',
    defaultTitle: 'Simulated authentication compromise — Authentication Service',
    description: 'SIMULATION: synthetic credential-stuffing and session-token abuse against the Authentication Service. Services that trust its tokens are flagged as potentially exposed; they are not declared compromised.',
    recoveryPlan: 'Rotate signing keys and credentials, redeploy the authentication service from a clean image (simulated).',
  },
  {
    scenarioType: 'database_outage',
    label: 'Database outage',
    initialAssetId: 'primary-db',
    effectKind: 'outage',
    effectLevel: 'offline',
    defaultTitle: 'Simulated outage — Primary (user) Database unavailable',
    description: 'SIMULATION: the primary user database stops responding. Services that require it become unavailable; services with non-critical dependencies degrade.',
    recoveryPlan: 'Fail over to the standby and restore from the last verified snapshot (simulated).',
  },
  {
    scenarioType: 'traffic_surge',
    label: 'Traffic surge (DDoS-like load)',
    initialAssetId: 'ext-gateway',
    effectKind: 'overload',
    effectLevel: 'degraded',
    defaultTitle: 'Simulated traffic surge — External Gateway',
    description: 'SIMULATION: abnormal synthetic request volume against the External Gateway. Latency and error rates rise and the gateway saturates if not mitigated. No real traffic is generated.',
    recoveryPlan: 'Scale out gateway capacity and keep WAF rules in place (simulated).',
  },
  {
    scenarioType: 'file_ransomware',
    label: 'Ransomware-like file service incident',
    initialAssetId: 'file-storage',
    effectKind: 'integrity',
    effectLevel: 'degraded',
    defaultTitle: 'Simulated ransomware-like activity — File Storage',
    description: 'SIMULATION: synthetic file-integrity alerts (mass renames, high-entropy writes) on the File Storage service. Consumers degrade and are flagged for lateral-spread risk until the service is isolated. No real files are touched.',
    recoveryPlan: 'Restore file shares from the immutable offsite vault after isolation (simulated).',
  },
];

/** Phase 1 scenario kept for existing records and API compatibility. */
export const LEGACY_SCENARIO: ScenarioDef = {
  scenarioType: RANSOMWARE_SCENARIO.scenarioType,
  label: 'Ransomware disruption (Phase 1)',
  initialAssetId: RANSOMWARE_SCENARIO.initialAssetId,
  effectKind: 'outage',
  effectLevel: 'offline',
  defaultTitle: RANSOMWARE_SCENARIO.defaultTitle,
  description: RANSOMWARE_SCENARIO.description,
  recoveryPlan: 'Restore the database host from the offsite vault (simulated).',
};

export function scenarioByType(type: string): ScenarioDef | undefined {
  return type === LEGACY_SCENARIO.scenarioType ? LEGACY_SCENARIO : SCENARIOS.find(s => s.scenarioType === type);
}

export interface EvidenceDraft {
  kind: string;
  title: string;
  detail: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  indicators: { key: string; value: string }[];
}

/** Deterministic synthetic evidence for a scenario. `rand` must return [0, 1). */
export function scenarioEvidence(scenarioType: string, rand: () => number): EvidenceDraft[] {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const ip = (net: '198.51.100' | '203.0.113' | '192.0.2') => `${net}.${int(2, 254)}`;
  switch (scenarioType) {
    case 'auth_compromise': {
      const fails = int(1400, 2600);
      const sources = int(25, 60);
      return [
        { kind: 'auth_log', title: 'Credential-stuffing burst', detail: `${fails} failed sign-ins from ${sources} source addresses within 4 minutes against 312 distinct accounts.`, severity: 'high', indicators: [{ key: 'failed_logins', value: String(fails) }, { key: 'source_ips', value: String(sources) }, { key: 'sample_ip', value: ip('198.51.100') }, { key: 'window', value: '4m' }] },
        { kind: 'auth_log', title: 'Impossible travel on administrator account', detail: 'Account adm.jrivera (synthetic) authenticated from Dallas, US and Frankfurt, DE eleven minutes apart.', severity: 'high', indicators: [{ key: 'account', value: 'adm.jrivera' }, { key: 'geo_a', value: 'Dallas, US' }, { key: 'geo_b', value: 'Frankfurt, DE' }, { key: 'sample_ip', value: ip('203.0.113') }] },
        { kind: 'auth_log', title: 'MFA push fatigue', detail: `${int(18, 31)} MFA push prompts sent to the same administrator within 6 minutes; one was approved.`, severity: 'critical', indicators: [{ key: 'account', value: 'adm.jrivera' }, { key: 'mfa_result', value: 'approved' }] },
        { kind: 'auth_log', title: 'Session tokens minted with elevated scope', detail: 'Three refresh tokens with admin:* scope issued outside the change window.', severity: 'critical', indicators: [{ key: 'token_scope', value: 'admin:*' }, { key: 'tokens', value: '3' }] },
      ];
    }
    case 'database_outage':
    case 'simulated_ransomware':
      return [
        { kind: 'db_health', title: 'Primary heartbeat lost', detail: `No heartbeat from the primary node for ${int(45, 90)} s; health probe returned TCP reset.`, severity: 'critical', indicators: [{ key: 'probe', value: 'tcp/5432' }, { key: 'result', value: 'RST' }] },
        { kind: 'db_health', title: 'Connection pool exhausted', detail: 'Application connection pools report 0 of 200 connections available; 1,180 requests queued.', severity: 'high', indicators: [{ key: 'pool_available', value: '0/200' }, { key: 'queued', value: '1180' }] },
        { kind: 'db_health', title: 'Replication stalled', detail: `Standby replica stopped applying WAL; replication lag ${int(120, 300)} s and climbing.`, severity: 'medium', indicators: [{ key: 'replica', value: 'standby-1' }] },
      ];
    case 'traffic_surge': {
      const mult = (8 + rand() * 6).toFixed(1);
      return [
        { kind: 'traffic', title: 'Request rate anomaly', detail: `Inbound request rate ${mult}× the 7-day baseline, concentrated on /api/search and /login.`, severity: 'high', indicators: [{ key: 'multiplier', value: mult }, { key: 'top_path', value: '/api/search' }] },
        { kind: 'traffic', title: 'Concentrated source networks', detail: `${int(70, 85)}% of new connections originate from three autonomous systems; sample ${ip('203.0.113')}.`, severity: 'medium', indicators: [{ key: 'asn_count', value: '3' }, { key: 'sample_ip', value: ip('203.0.113') }] },
        { kind: 'traffic', title: 'Latency and 5xx rising', detail: `p99 latency ${int(1800, 3200)} ms; 5xx ratio ${int(9, 19)}%.`, severity: 'high', indicators: [{ key: 'p99_ms', value: String(int(1800, 3200)) }] },
      ];
    }
    case 'file_ransomware': {
      const files = int(3800, 5200);
      return [
        { kind: 'file_integrity', title: 'Mass file renames', detail: `${files} files renamed with a .locked extension under /shares/finance within 3 minutes (synthetic share).`, severity: 'critical', indicators: [{ key: 'files', value: String(files) }, { key: 'extension', value: '.locked' }, { key: 'path', value: '/shares/finance' }] },
        { kind: 'file_integrity', title: 'High-entropy writes', detail: 'Average write entropy rose from 4.1 to 7.9 bits/byte, consistent with encryption.', severity: 'high', indicators: [{ key: 'entropy_before', value: '4.1' }, { key: 'entropy_after', value: '7.9' }] },
        { kind: 'file_integrity', title: 'Ransom note created', detail: 'README_RESTORE.txt created in 214 directories (synthetic).', severity: 'high', indicators: [{ key: 'file', value: 'README_RESTORE.txt' }, { key: 'directories', value: '214' }] },
        { kind: 'file_integrity', title: 'Snapshot deletion attempt', detail: `Service account svc-filesync attempted to delete local snapshots from ${ip('192.0.2')}; denied by policy.`, severity: 'critical', indicators: [{ key: 'account', value: 'svc-filesync' }, { key: 'result', value: 'denied' }] },
      ];
    }
    default:
      return [];
  }
}
