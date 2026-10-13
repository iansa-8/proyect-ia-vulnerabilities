import type { ProjectProfile, ProjectRecord } from './project';

export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'rolled_back';

export type PipelineRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'rolled_back';

/** Extensible rollback policy. Prefer `none` for product demo pipelines. */
export type RollbackPolicy = 'none' | 'onFailure' | 'onValidationFailure';

/**
 * Extensible run context. Prefer typed helpers for known keys;
 * use `data` as a controlled bag for Sonar/indexer/agent/git results later.
 */
export interface PipelineContext {
  runId: string;
  project: ProjectRecord;
  projectProfile: ProjectProfile;
  data: Map<string, unknown>;
}

export interface PipelineStepResult {
  stepId: string;
  status: PipelineStepStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Bounded payload only — never megabyte stdout. */
  result?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface PipelineStep {
  id: string;
  name: string;
  execute(context: PipelineContext): Promise<PipelineStepResult>;
  rollback?(context: PipelineContext): Promise<void>;
}

/** Serializable step reference inside a definition (no class instances). */
export interface PipelineStepRef {
  stepId: string;
  config?: Record<string, unknown>;
}

/**
 * Declarative pipeline. Persisted definitions may live in a code registry;
 * RUNS are stored in SQLite — never class instances.
 */
export interface PipelineDefinition {
  id: string;
  name: string;
  description: string;
  steps: PipelineStepRef[];
  rollbackPolicy: RollbackPolicy;
}

export const PIPELINE_STEP_STATUSES: readonly PipelineStepStatus[] = [
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
  'rolled_back',
] as const;

export const PIPELINE_RUN_STATUSES: readonly PipelineRunStatus[] = [
  'pending',
  'running',
  'success',
  'failed',
  'cancelled',
  'rolled_back',
] as const;

export function isPipelineStepStatus(value: string): value is PipelineStepStatus {
  return (PIPELINE_STEP_STATUSES as readonly string[]).includes(value);
}

export function isPipelineRunStatus(value: string): value is PipelineRunStatus {
  return (PIPELINE_RUN_STATUSES as readonly string[]).includes(value);
}

export function getContextData<T>(
  context: PipelineContext,
  key: string,
): T | undefined {
  const value = context.data.get(key);
  return value as T | undefined;
}

export function setContextData(
  context: PipelineContext,
  key: string,
  value: unknown,
): void {
  context.data.set(key, value);
}
