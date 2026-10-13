import { Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import { mergeProjectProfile } from '@amp/core';

/**
 * Loads the persisted project + profile from context (already resolved by the
 * orchestration layer). Does NOT re-run ProjectDetector.
 */
@Injectable()
export class LoadProjectStep implements PipelineStep {
  readonly id = 'load-project';
  readonly name = 'Load Project';

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();

    if (!context.project?.id) {
      return this.fail(startedAt, started, 'Project missing in pipeline context');
    }
    if (!context.project.profile) {
      return this.fail(
        startedAt,
        started,
        'Project profile is missing — select/analyze the project before running the pipeline',
      );
    }

    const effective = mergeProjectProfile(
      context.project.profile,
      context.project.commandOverrides,
    );
    context.data.set('effectiveProfile', effective);
    context.data.set('loadProject.ok', true);

    const finished = new Date();
    return {
      stepId: this.id,
      status: 'success',
      startedAt,
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      result: {
        projectId: context.project.id,
        path: context.project.path,
        runtime: effective.runtime,
        framework: effective.framework,
      },
    };
  }

  private fail(
    startedAt: string,
    started: Date,
    error: string,
  ): PipelineStepResult {
    const finished = new Date();
    return {
      stepId: this.id,
      status: 'failed',
      startedAt,
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      error,
    };
  }
}
