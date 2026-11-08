// Domain vocabulary shared by the UI. These string unions mirror the values the
// SpacetimeDB module validates server-side (spacetime/src/validation.ts).
import type {
  Asset,
  Dependency,
  Incident,
  IncidentAsset,
  IncidentDecision,
  IncidentEvent,
  IncidentMessage,
  RecoveryAction,
  Responder,
  ResponseTask,
  AuditEvent,
  SystemConfig,
  AiInvestigation,
  AiFinding,
  AiStep,
  ServicePrincipal,
  TelemetrySample,
  IncidentEffect,
  IncidentEvidence,
  TelemetryMetric,
  SimulationState,
  SensorNode,
  SensorReading,
  ResponseProposal,
  DecisionExplanation,
} from '../module_bindings/types';

export type {
  ResponseProposal,
  DecisionExplanation,
  SensorNode,
  SensorReading,
  Asset,
  Dependency,
  Incident,
  IncidentAsset,
  IncidentDecision,
  IncidentEvent,
  IncidentMessage,
  RecoveryAction,
  Responder,
  ResponseTask,
  AuditEvent,
  SystemConfig,
  AiInvestigation,
  AiFinding,
  AiStep,
  ServicePrincipal,
  TelemetrySample,
  IncidentEffect,
  IncidentEvidence,
  TelemetryMetric,
  SimulationState,
};

export type HealthStatus = 'healthy' | 'degraded' | 'critical' | 'offline' | 'recovering';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'investigating' | 'contained' | 'recovering' | 'resolved';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export type Role = 'incident_commander' | 'security_analyst' | 'legal_responder' | 'observer';

export const ROLES: Role[] = ['incident_commander', 'security_analyst', 'legal_responder', 'observer'];
export const ROLE_LABEL: Record<Role, string> = {
  incident_commander: 'Incident Commander',
  security_analyst: 'Security Analyst',
  legal_responder: 'Legal Responder',
  observer: 'Observer',
};

export const INCIDENT_NEXT: Record<IncidentStatus, IncidentStatus[]> = {
  open: ['investigating', 'contained'],
  investigating: ['contained', 'recovering'],
  contained: ['investigating', 'recovering'],
  recovering: ['investigating', 'contained'],
  resolved: [],
};

export const TASK_NEXT: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'blocked', 'done'],
  in_progress: ['todo', 'blocked', 'done'],
  blocked: ['todo', 'in_progress'],
  done: ['in_progress'],
};

/** Client-side mirror of server permissions — used only to hide/disable UI. The server enforces. */
const ANY_RESPONDER: Role[] = ['incident_commander', 'security_analyst', 'legal_responder', 'observer'];

export const CAN: Record<string, Role[]> = {
  launchSimulation: ['incident_commander', 'security_analyst'],
  injectFault: ['incident_commander', 'security_analyst'],
  updateIncidentStatus: ANY_RESPONDER,
  recordEvent: ['incident_commander', 'security_analyst', 'legal_responder'],
  createTask: ['incident_commander', 'security_analyst'],
  recordDecision: ['incident_commander', 'legal_responder'],
  sendMessage: ['incident_commander', 'security_analyst', 'legal_responder'],
  requestRecovery: ANY_RESPONDER,
  decideRecovery: ANY_RESPONDER,
  resolveIncident: ANY_RESPONDER,
  administer: ['incident_commander'],
  requestAi: ['incident_commander', 'security_analyst'],
  contain: ANY_RESPONDER,
  decideAiRecommendation: ['incident_commander', 'security_analyst'],
  proposeResponse: ANY_RESPONDER,
  decideResponse: ANY_RESPONDER,
};

/** Display labels. 'open' is stored for compatibility and shown as "Detected". */
export const INCIDENT_STATUS_LABEL: Record<string, string> = {
  open: 'Detected',
  investigating: 'Investigating',
  contained: 'Contained',
  recovering: 'Recovering',
  resolved: 'Resolved',
};

export const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
