import type {
  PipelineContext,
  PipelineDefinition,
  PipelineRunStatus,
  PipelineStep,
  PipelineStepResult,
  PlatformEvent,
  RollbackPolicy,
} from '@amp/core';
import type {
  PipelineEngine,
  PipelineExecutionResult,
  RunPipelineOptions,
  StepExecutionSnapshot,
} from './engine';

/**
 * Sequential pipeline engine with registry + definitions.
 * Loop is data-driven (definition.steps) — not a hardcoded 3-step chain.
 * Parallelism is not used; the structure does not prevent adding it later.
 */
export class SequentialPipelineEngine implements PipelineEngine {
  private readonly steps = new Map<string, PipelineStep>();
  private readonly definitions = new Map<string, PipelineDefinition>();

  registerStep(step: PipelineStep): void {
    if (this.steps.has(step.id)) {
      throw new Error(`Step already registered: ${step.id}`);
    }
    this.steps.set(step.id, step);
  }

  getSteps(): readonly PipelineStep[] {
    return [...this.steps.values()];
  }

  getStep(stepId: string): PipelineStep | undefined {
    return this.steps.get(stepId);
  }

  registerDefinition(definition: PipelineDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`Pipeline definition already registered: ${definition.id}`);
    }
    for (const ref of definition.steps) {
      if (!this.steps.has(ref.stepId)) {
        throw new Error(
          `Cannot register definition ${definition.id}: unknown step ${ref.stepId}`,
        );
      }
    }
    this.definitions.set(definition.id, definition);
  }

  getDefinitions(): readonly PipelineDefinition[] {
    return [...this.definitions.values()];
  }

  getDefinition(id: string): PipelineDefinition | undefined {
    return this.definitions.get(id);
  }

  async runStep(
    stepId: string,
    context: PipelineContext,
  ): Promise<PipelineStepResult> {
    const step = this.steps.get(stepId);
    if (!step) {
      throw new Error(`Unknown step: ${stepId}`);
    }
    return step.execute(context);
  }

  async run(
    definitionId: string,
    context: PipelineContext,
    options: RunPipelineOptions = {},
  ): Promise<PipelineExecutionResult> {
    const definition = this.definitions.get(definitionId);
    if (!definition) {
      throw new Error(`Unknown pipeline definition: ${definitionId}`);
    }

    const policy: RollbackPolicy =
      options.rollbackPolicy ?? definition.rollbackPolicy;
    const runStarted = new Date();
    const steps: StepExecutionSnapshot[] = [];
    const rollbackSteps: PipelineStep[] = [];

    await options.onRunStatus?.('running');
    this.emit(options, {
      type: 'pipeline.started',
      timestamp: runStarted.toISOString(),
      payload: {
        runId: context.runId,
        projectId: context.project.id,
        pipelineDefinitionId: definition.id,
      },
    });

    let runError: string | undefined;

    for (let i = 0; i < definition.steps.length; i++) {
      const ref = definition.steps[i];
      const step = this.steps.get(ref.stepId);
      if (!step) {
        runError = `Unknown step: ${ref.stepId}`;
        break;
      }

      if (ref.config) {
        context.data.set(`config:${ref.stepId}`, ref.config);
      }

      const stepStarted = new Date();
      const startedAt = stepStarted.toISOString();

      const runningSnap: StepExecutionSnapshot = {
        stepId: step.id,
        name: step.name,
        status: 'running',
        startedAt,
        finishedAt: null,
        durationMs: null,
        stepOrder: i,
      };
      steps.push(runningSnap);
      await options.onStepRecord?.(runningSnap);

      this.emit(options, {
        type: 'step.started',
        timestamp: startedAt,
        payload: {
          runId: context.runId,
          stepId: step.id,
          stepName: step.name,
        },
      });

      let result: PipelineStepResult;
      try {
        result = await step.execute(context);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const finishedAt = new Date();
        result = {
          stepId: step.id,
          status: 'failed',
          startedAt,
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - stepStarted.getTime(),
          error: message,
        };
      }

      const finishedSnap: StepExecutionSnapshot = {
        stepId: step.id,
        name: step.name,
        status: result.status,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        result: result.result,
        error: result.error,
        stepOrder: i,
      };
      steps[i] = finishedSnap;
      await options.onStepRecord?.(finishedSnap);

      if (step.rollback && !rollbackSteps.includes(step)) rollbackSteps.push(step);

      if (result.status === 'success' || result.status === 'skipped') {
        this.emit(options, {
          type: 'step.completed',
          timestamp: result.finishedAt,
          payload: {
            runId: context.runId,
            stepId: step.id,
            durationMs: result.durationMs,
          },
        });
      } else {
        const errorMsg =
          result.error ?? `Step ${step.id} finished with status ${result.status}`;
        runError = errorMsg;
        this.emit(options, {
          type: 'step.failed',
          timestamp: result.finishedAt,
          payload: {
            runId: context.runId,
            stepId: step.id,
            error: errorMsg,
          },
        });
        break;
      }
    }

    if (runError && policy !== 'none' && rollbackSteps.length > 0) {
      const rollbackError = await this.rollbackSuccessful(rollbackSteps, context, steps, options);
      if (rollbackError) runError = `${runError}; ${rollbackError}`;
    }

    const runFinished = new Date();
    const terminalStatus: PipelineRunStatus = runError ? 'failed' : 'success';

    await options.onRunStatus?.(terminalStatus, runError);

    if (runError) {
      this.emit(options, {
        type: 'pipeline.failed',
        timestamp: runFinished.toISOString(),
        payload: { runId: context.runId, error: runError },
      });
      this.emit(options, {
        type: 'pipeline.completed',
        timestamp: runFinished.toISOString(),
        payload: { runId: context.runId, success: false },
      });
    } else {
      this.emit(options, {
        type: 'pipeline.completed',
        timestamp: runFinished.toISOString(),
        payload: { runId: context.runId, success: true },
      });
    }

    return {
      runId: context.runId,
      pipelineDefinitionId: definition.id,
      status: terminalStatus,
      steps,
      startedAt: runStarted.toISOString(),
      finishedAt: runFinished.toISOString(),
      durationMs: runFinished.getTime() - runStarted.getTime(),
      error: runError,
    };
  }

  private async rollbackSuccessful(
    successfulSteps: PipelineStep[],
    context: PipelineContext,
    steps: StepExecutionSnapshot[],
    options: RunPipelineOptions,
  ): Promise<string | undefined> {
    let rollbackError: string | undefined;
    for (let i = successfulSteps.length - 1; i >= 0; i--) {
      const step = successfulSteps[i];
      if (!step.rollback) {
        continue;
      }
      try {
        await step.rollback(context);
        const snapIndex = steps.findIndex((s) => s.stepId === step.id);
        if (snapIndex >= 0) {
          const prev = steps[snapIndex];
          const rolled: StepExecutionSnapshot = {
            ...prev,
            status: 'rolled_back',
          };
          steps[snapIndex] = rolled;
          await options.onStepRecord?.(rolled);
        }
      } catch (error) {
        rollbackError = error instanceof Error ? error.message : String(error);
      }
    }
    return rollbackError;
  }

  private emit(options: RunPipelineOptions, event: PlatformEvent): void {
    options.emit?.(event);
  }
}

/** @deprecated Alias kept for DI compatibility during Phase 3. */
export { SequentialPipelineEngine as InMemoryPipelineEngine };
