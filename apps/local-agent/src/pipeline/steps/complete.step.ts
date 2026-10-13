import { Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';

/**
 * Terminal success marker for the demo pipeline.
 * Includes an optional observable rollback marker for engine tests / onFailure demos
 * (does NOT touch user files). Product demo uses rollbackPolicy: none.
 */
@Injectable()
export class CompleteStep implements PipelineStep {
  readonly id = 'complete';
  readonly name = 'Complete';

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();
    context.data.set('complete.ok', true);
    context.data.set('complete.rollbackCount', 0);

    const finished = new Date();
    return {
      stepId: this.id,
      status: 'success',
      startedAt,
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      result: { completed: true },
    };
  }

  async rollback(context: PipelineContext): Promise<void> {
    const prev = context.data.get('complete.rollbackCount');
    const count = typeof prev === 'number' ? prev + 1 : 1;
    context.data.set('complete.rollbackCount', count);
    context.data.set('complete.rolledBack', true);
  }
}
