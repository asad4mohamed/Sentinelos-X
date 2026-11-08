// Single boundary to the SpacetimeDB module's pure, dependency-free engine code.
// The browser uses it ONLY for clearly labeled previews ("expected impact");
// authoritative state is always computed by reducers inside SpacetimeDB.
export {
  computeBlastRadius,
  severityFromBlast,
  resolveEffect,
  CONTAINMENT,
  type AssetBlast,
  type EffectInput,
  type EffectKind,
  type EffectPhase,
  type GraphEdge,
  type DependencyType,
  type Criticality,
} from '../../../spacetime/src/propagation';
export { SCENARIOS, LEGACY_SCENARIO, scenarioByType, type ScenarioDef } from '../../../spacetime/src/seed';
export {
  evaluateAll,
  evaluateStrategy,
  recommend,
  type LabRecommendation,
  rootTargets,
  stateFingerprint,
  STRATEGY_IDS,
  STRATEGY_NAME,
  STATE_RANK,
  LabError,
  type LabInput,
  type LabReport,
  type StrategyResult,
  type StrategyId,
  type AssetState,
  type ImpactSnapshot,
} from '../../../spacetime/src/decisionLab';
