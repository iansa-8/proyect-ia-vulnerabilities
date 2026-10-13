import type {
  PipelineContext,
  PipelineDefinition,
  PipelineRunStatus,
  PipelineStep,
  PipelineStepResult,
  PlatformEvent,
  RollbackPolicy,
} from '@amp/core';

/**
 * Contract for a composable pipeline engine.
 * Intentionally NO runEverything() that chains index/sonar/agent/build/test.
 *
 * Future steps (IndexProjectStep → IndexerProvider / CodebaseMemoryIndexerProvider;
 * AgentExecutionStep → AgentProvider / CursorAgentProvider) register here without
 * changing the engine loop.
 */
export interface PipelineEngine {
  registerStep(step: PipelineStep): void;
  getSteps(): readonly PipelineStep[];
  getStep(stepId: string): PipelineStep | undefined;
  registerDefinition(definition: PipelineDefinition): void;
  getDefinitions(): readonly PipelineDefinition[];
  getDefinition(id: string): PipelineDefinition | undefined;
  runStep(stepId: string, context: PipelineContext): Promise<PipelineStepResult>;
  run(
    definitionId: string,
    context: PipelineContext,
    options?: RunPipelineOptions,
  ): Promise<PipelineExecutionResult>;
}

export type PipelineRunRecordStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'rolled_back';

/** Persisted run header (SQLite). Status aligned with PipelineRunStatus. */
export interface PipelineRunRecord {
  id: string;
  pipelineDefinitionId: string;
  projectId: string;
  status: PipelineRunRecordStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StepRunRecord {
  id: string;
  runId: string;
  stepId: string;
  name: string;
  status: PipelineStepResult['status'];
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Bounded JSON summary — never full stdout. */
  resultJson: string | null;
  error: string | null;
  stepOrder: number;
}

export interface RunPipelineOptions {
  /** Override definition policy when testing. */
  rollbackPolicy?: RollbackPolicy;
  emit?: (event: PlatformEvent) => void;
  /** Called after each step state change (for persistence). */
  onStepRecord?: (record: StepExecutionSnapshot) => void | Promise<void>;
  onRunStatus?: (
    status: PipelineRunStatus,
    error?: string,
  ) => void | Promise<void>;
}

export interface StepExecutionSnapshot {
  stepId: string;
  name: string;
  status: PipelineStepResult['status'];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  result?: unknown;
  error?: string;
  stepOrder: number;
}

export interface PipelineExecutionResult {
  runId: string;
  pipelineDefinitionId: string;
  status: PipelineRunStatus;
  steps: StepExecutionSnapshot[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string;
}
