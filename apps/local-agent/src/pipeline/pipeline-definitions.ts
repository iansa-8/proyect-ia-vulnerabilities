import type { PipelineDefinition } from '@amp/core';

/**
 * Demo product pipeline. Rollback policy: none.
 *
 * Placeholder step ids (NOT registered as executables here — avoid broken runs):
 * - build / unit-tests / e2e → future validators via CommandExecutionService
 * - report → future reporting package
 * - agent-execution → future AgentExecutionStep → AgentProvider (CursorAgentProvider)
 */
export const BASIC_PROJECT_CHECK_DEFINITION: PipelineDefinition = {
  id: 'basic-project-check',
  name: 'Basic Project Check',
  description:
    'Carga el proyecto persistido, valida el directorio y marca éxito. Sin build/test.',
  rollbackPolicy: 'none',
  steps: [
    { stepId: 'load-project' },
    { stepId: 'validate-directory' },
    { stepId: 'complete' },
  ],
};

/**
 * Indexes a registered project via IndexerProvider (CLI).
 * Engine does not know Codebase Memory — only IndexerProvider.
 */
export const PROJECT_INDEXING_DEFINITION: PipelineDefinition = {
  id: 'project-indexing',
  name: 'Project Indexing',
  description:
    'Carga el proyecto, valida el directorio, verifica el indexer e indexa el código.',
  rollbackPolicy: 'none',
  steps: [
    { stepId: 'load-project' },
    { stepId: 'validate-directory' },
    { stepId: 'check-indexer' },
    { stepId: 'index-project' },
  ],
};

/**
 * Quality analysis via QualityProvider (engine does not know Sonar).
 * Check Code Index only records state — does not fail on stale/absent.
 * Read-only: does not run scanner or create remote projects.
 */
export const QUALITY_ANALYSIS_DEFINITION: PipelineDefinition = {
  id: 'quality-analysis',
  name: 'Quality Analysis',
  description:
    'Conecta al proveedor de calidad, descarga todos los issues paginados y crea un snapshot. No modifica el repo analizado.',
  rollbackPolicy: 'none',
  steps: [
    { stepId: 'load-project' },
    { stepId: 'validate-directory' },
    { stepId: 'check-code-index' },
    { stepId: 'check-quality-provider' },
    { stepId: 'download-quality-issues' },
    { stepId: 'create-quality-snapshot' },
    { stepId: 'complete' },
  ],
};

/**
 * Full Sonar baseline: ensure remote project, run local scanner, wait CE, snapshot.
 * Engine depends on QualityProvider + QualityAnalyzer — never NodeSonarAnalyzer by name.
 */
export const SONAR_BASELINE_DEFINITION: PipelineDefinition = {
  id: 'sonar-baseline',
  name: 'Sonar Baseline Analysis',
  description:
    'Asegura el proyecto en Sonar, ejecuta el scanner local, espera el procesamiento y crea un snapshot. No escribe en el repo analizado.',
  rollbackPolicy: 'none',
  steps: [
    { stepId: 'load-project' },
    { stepId: 'validate-directory' },
    { stepId: 'check-quality-provider' },
    { stepId: 'ensure-quality-project' },
    { stepId: 'check-quality-analyzer' },
    { stepId: 'run-quality-analysis' },
    { stepId: 'wait-quality-processing' },
    { stepId: 'download-quality-issues' },
    { stepId: 'create-quality-snapshot' },
    { stepId: 'complete' },
  ],
};

export const QUALITY_FIX_PROPOSAL_DEFINITION: PipelineDefinition = {
  id: 'quality-fix-proposal',
  name: 'Quality Fix Proposal',
  description:
    'Resuelve contexto acotado y solicita una propuesta estructurada en modo solo lectura. No modifica archivos.',
  rollbackPolicy: 'none',
  steps: [
    { stepId: 'load-project' },
    { stepId: 'load-quality-issue' },
    { stepId: 'check-code-index' },
    { stepId: 'resolve-quality-context' },
    { stepId: 'capture-working-tree-baseline' },
    { stepId: 'propose-fix' },
    { stepId: 'verify-repository-unchanged' },
    { stepId: 'persist-agent-proposal' },
    { stepId: 'complete' },
  ],
};

export const QUALITY_FIX_APPLICATION_DEFINITION: PipelineDefinition = {
  id: 'quality-fix-application',
  name: 'Quality Fix Application',
  description: 'Aplica una propuesta aprobada, valida el cambio, reanaliza Sonar y revierte únicamente el delta del run si falla.',
  rollbackPolicy: 'onValidationFailure',
  steps: [
    { stepId: 'load-project' },
    { stepId: 'load-approved-proposal' },
    { stepId: 'load-quality-issue' },
    { stepId: 'check-code-index' },
    { stepId: 'resolve-quality-context' },
    { stepId: 'validate-approved-proposal' },
    { stepId: 'capture-git-baseline' },
    { stepId: 'check-apply-agent-provider' },
    { stepId: 'apply-approved-fix' },
    { stepId: 'capture-run-changes' },
    { stepId: 'validate-change-scope' },
    { stepId: 'validate-fix-build', config: { required: true, timeoutMs: 600000 } },
    { stepId: 'validate-fix-unit', config: { required: true, timeoutMs: 600000 } },
    { stepId: 'validate-fix-e2e', config: { required: false, timeoutMs: 600000 } },
    { stepId: 'validate-fix-startup', config: {
      required: process.env.FIX_VALIDATION_STARTUP_REQUIRED !== 'false',
      timeoutMs: Number(process.env.FIX_STARTUP_TIMEOUT_MS ?? 60_000),
      readinessMs: Number(process.env.FIX_STARTUP_READINESS_MS ?? 5_000),
    } },
    { stepId: 'validate-fix-health', config: {
      required: process.env.FIX_VALIDATION_HEALTH_REQUIRED === 'true',
      healthUrl: process.env.FIX_HEALTH_URL,
      pollIntervalMs: Number(process.env.FIX_HEALTH_POLL_INTERVAL_MS ?? 1_000),
    } },
    { stepId: 'check-quality-provider' },
    { stepId: 'ensure-quality-project' },
    { stepId: 'check-quality-analyzer' },
    { stepId: 'run-quality-analysis' },
    { stepId: 'wait-quality-processing' },
    { stepId: 'download-quality-issues' },
    { stepId: 'create-quality-snapshot' },
    { stepId: 'compare-quality-snapshots' },
    { stepId: 'generate-fix-report' },
    { stepId: 'complete' },
  ],
};

export const QUALITY_BULK_FIX_APPLICATION_DEFINITION: PipelineDefinition = {
  id: 'quality-bulk-fix-application',
  name: 'Bulk Quality Fix Application',
  description: 'Aplica varias propuestas aprobadas con una llamada al agente y ejecuta la validación completa una sola vez.',
  rollbackPolicy: 'onValidationFailure',
  steps: [
    { stepId: 'load-project' },
    { stepId: 'load-bulk-approved-proposals' },
    { stepId: 'check-code-index' },
    { stepId: 'validate-bulk-approved-proposals' },
    { stepId: 'capture-git-baseline' },
    { stepId: 'check-bulk-apply-agent-provider' },
    { stepId: 'apply-bulk-approved-fixes' },
    { stepId: 'capture-run-changes' },
    { stepId: 'validate-change-scope' },
    { stepId: 'validate-fix-build', config: { required: true, timeoutMs: 600000 } },
    { stepId: 'validate-fix-unit', config: { required: true, timeoutMs: 600000 } },
    { stepId: 'validate-fix-e2e', config: { required: false, timeoutMs: 600000 } },
    { stepId: 'validate-fix-startup', config: {
      required: process.env.FIX_VALIDATION_STARTUP_REQUIRED !== 'false',
      timeoutMs: Number(process.env.FIX_STARTUP_TIMEOUT_MS ?? 60_000),
      readinessMs: Number(process.env.FIX_STARTUP_READINESS_MS ?? 5_000),
    } },
    { stepId: 'validate-fix-health', config: {
      required: process.env.FIX_VALIDATION_HEALTH_REQUIRED === 'true',
      healthUrl: process.env.FIX_HEALTH_URL,
      pollIntervalMs: Number(process.env.FIX_HEALTH_POLL_INTERVAL_MS ?? 1_000),
    } },
    { stepId: 'check-quality-provider' },
    { stepId: 'ensure-quality-project' },
    { stepId: 'check-quality-analyzer' },
    { stepId: 'run-quality-analysis' },
    { stepId: 'wait-quality-processing' },
    { stepId: 'download-quality-issues' },
    { stepId: 'create-quality-snapshot' },
    { stepId: 'compare-bulk-quality-snapshots' },
    { stepId: 'complete' },
  ],
};

export const PIPELINE_DEFINITIONS: readonly PipelineDefinition[] = [
  BASIC_PROJECT_CHECK_DEFINITION,
  PROJECT_INDEXING_DEFINITION,
  QUALITY_ANALYSIS_DEFINITION,
  SONAR_BASELINE_DEFINITION,
  QUALITY_FIX_PROPOSAL_DEFINITION,
  QUALITY_FIX_APPLICATION_DEFINITION,
  QUALITY_BULK_FIX_APPLICATION_DEFINITION,
];
