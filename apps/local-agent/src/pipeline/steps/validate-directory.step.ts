import { Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import {
  assertExistingProjectDirectory,
  PathNotFoundError,
  PathValidationError,
  validateProjectPath,
} from '../../common/path-validation';

/**
 * Validates that the project path exists and is a directory.
 * Does NOT run build/test.
 */
@Injectable()
export class ValidateDirectoryStep implements PipelineStep {
  readonly id = 'validate-directory';
  readonly name = 'Validate Directory';

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();

    try {
      const safe = validateProjectPath(context.project.path);
      assertExistingProjectDirectory(safe);
      context.data.set('validatedPath', safe);

      const finished = new Date();
      return {
        stepId: this.id,
        status: 'success',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        result: { path: safe, exists: true, isDirectory: true },
      };
    } catch (err: unknown) {
      const message =
        err instanceof PathValidationError || err instanceof PathNotFoundError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      const finished = new Date();
      return {
        stepId: this.id,
        status: 'failed',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        error: message,
      };
    }
  }
}
