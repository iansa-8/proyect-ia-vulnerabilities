export type PlatformEventType =
  | 'pipeline.started'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'pipeline.completed'
  | 'pipeline.failed'
  | 'file.modified'
  | 'validation.started'
  | 'validation.completed'
  | 'connection.hello'
  | 'index.started'
  | 'index.completed'
  | 'index.failed'
  | 'index.progress';

export interface PlatformEventBase<TType extends PlatformEventType, TPayload> {
  type: TType;
  timestamp: string;
  payload: TPayload;
}

export type PipelineStartedEvent = PlatformEventBase<
  'pipeline.started',
  { runId: string; projectId: string; pipelineDefinitionId: string }
>;

export type StepStartedEvent = PlatformEventBase<
  'step.started',
  { runId: string; stepId: string; stepName: string }
>;

export type StepCompletedEvent = PlatformEventBase<
  'step.completed',
  { runId: string; stepId: string; durationMs: number }
>;

export type StepFailedEvent = PlatformEventBase<
  'step.failed',
  { runId: string; stepId: string; error: string }
>;

export type PipelineCompletedEvent = PlatformEventBase<
  'pipeline.completed',
  { runId: string; success: boolean }
>;

export type PipelineFailedEvent = PlatformEventBase<
  'pipeline.failed',
  { runId: string; error: string }
>;

export type FileModifiedEvent = PlatformEventBase<
  'file.modified',
  { runId: string; path: string }
>;

export type ValidationStartedEvent = PlatformEventBase<
  'validation.started',
  { runId: string; validatorId: string }
>;

export type ValidationCompletedEvent = PlatformEventBase<
  'validation.completed',
  { runId: string; validatorId: string; success: boolean }
>;

export type ConnectionHelloEvent = PlatformEventBase<
  'connection.hello',
  { message: string; serverTime: string }
>;

export type IndexStartedEvent = PlatformEventBase<
  'index.started',
  { projectId: string; provider: string }
>;

export type IndexCompletedEvent = PlatformEventBase<
  'index.completed',
  {
    projectId: string;
    provider: string;
    providerProjectName?: string;
    durationMs: number;
    skipped?: boolean;
  }
>;

export type IndexFailedEvent = PlatformEventBase<
  'index.failed',
  { projectId: string; provider: string; error: string }
>;

/** Only emitted when the indexer CLI reports real progress — never simulated. */
export type IndexProgressEvent = PlatformEventBase<
  'index.progress',
  { projectId: string; message: string }
>;

export type PlatformEvent =
  | PipelineStartedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | StepFailedEvent
  | PipelineCompletedEvent
  | PipelineFailedEvent
  | FileModifiedEvent
  | ValidationStartedEvent
  | ValidationCompletedEvent
  | ConnectionHelloEvent
  | IndexStartedEvent
  | IndexCompletedEvent
  | IndexFailedEvent
  | IndexProgressEvent;
