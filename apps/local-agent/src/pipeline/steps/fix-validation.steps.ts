import { Injectable } from '@nestjs/common';
import type { PipelineContext, PipelineStep, PipelineStepResult } from '@amp/core';
import { ValidationRunnerService, type FixValidationKind, type FixValidationResult } from '../../validation/validation-runner.service';

abstract class ValidationStep implements PipelineStep {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly kind: FixValidationKind;
  constructor(protected readonly runner: ValidationRunnerService) {}
  protected abstract command(context: PipelineContext): string | undefined;

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const config = (context.data.get(`config:${this.id}`) ?? {}) as {
      required?: boolean; timeoutMs?: number; readinessMs?: number; pollIntervalMs?: number; healthUrl?: string;
    };
    const required = config.required === true;
    if (this.kind === 'startup') {
      const healthConfig = (context.data.get('config:validate-fix-health') ?? {}) as {
        required?: boolean; timeoutMs?: number; pollIntervalMs?: number; healthUrl?: string;
      };
      const bundle = await this.runner.runStartup({
        projectPath: context.project.path,
        commandLine: this.command(context),
        required,
        healthUrl: healthConfig.healthUrl,
        healthRequired: healthConfig.required === true,
        timeoutMs: config.timeoutMs,
        readinessMs: config.readinessMs,
        pollIntervalMs: healthConfig.pollIntervalMs ?? config.pollIntervalMs,
      });
      const validations = (context.data.get('fix.validations') ?? {}) as Record<string, FixValidationResult>;
      validations.startup = bundle.startup;
      context.data.set('fix.validations', validations);
      context.data.set('fix.startupHealthResult', bundle.health);
      return finish(this.id, started, bundle.startup);
    }
    if (this.kind === 'health') {
      const result = context.data.get('fix.startupHealthResult') as FixValidationResult | undefined;
      const effective = result && result.status === 'failed' && !required
        ? { ...result, status: 'skipped' as const, summary: 'Optional health validation was not successful; continuing.' }
        : result ?? {
          kind: 'health' as const, required, status: required ? 'failed' as const : 'skipped' as const, durationMs: 0,
          summary: required ? 'Required health validation did not run' : 'Health endpoint is not configured for this project',
        };
      const validations = (context.data.get('fix.validations') ?? {}) as Record<string, FixValidationResult>;
      validations.health = effective;
      context.data.set('fix.validations', validations);
      return finish(this.id, started, effective);
    }
    const result = await this.runner.run({
      kind: this.kind,
      projectPath: context.project.path,
      commandLine: this.command(context),
      required,
      timeoutMs: config.timeoutMs,
    });
    const validations = (context.data.get('fix.validations') ?? {}) as Record<string, FixValidationResult>;
    validations[this.kind] = result;
    context.data.set('fix.validations', validations);
    return finish(this.id, started, result);
  }
}

@Injectable()
export class BuildValidationStep extends ValidationStep {
  readonly id = 'validate-fix-build'; readonly name = 'Build'; readonly kind = 'build' as const;
  constructor(runner: ValidationRunnerService) { super(runner); }
  protected command(context: PipelineContext) { return context.projectProfile.buildCommand; }
}
@Injectable()
export class UnitValidationStep extends ValidationStep {
  readonly id = 'validate-fix-unit'; readonly name = 'Unit Tests'; readonly kind = 'unit' as const;
  constructor(runner: ValidationRunnerService) { super(runner); }
  protected command(context: PipelineContext) { return context.projectProfile.coverageCommand ?? context.projectProfile.testCommand; }
}
@Injectable()
export class E2EValidationStep extends ValidationStep {
  readonly id = 'validate-fix-e2e'; readonly name = 'E2E Tests'; readonly kind = 'e2e' as const;
  constructor(runner: ValidationRunnerService) { super(runner); }
  protected command(context: PipelineContext) { return context.projectProfile.e2eCommand; }
}
@Injectable()
export class StartupValidationStep extends ValidationStep {
  readonly id = 'validate-fix-startup'; readonly name = 'Startup'; readonly kind = 'startup' as const;
  constructor(runner: ValidationRunnerService) { super(runner); }
  protected command(context: PipelineContext) { return context.projectProfile.startCommand; }
}
@Injectable()
export class HealthValidationStep extends ValidationStep {
  readonly id = 'validate-fix-health'; readonly name = 'Health Check'; readonly kind = 'health' as const;
  constructor(runner: ValidationRunnerService) { super(runner); }
  protected command() { return undefined; }
}

function finish(stepId: string, started: Date, result: FixValidationResult): PipelineStepResult {
  const finished = new Date();
  return {
    stepId,
    status: result.status === 'passed' ? 'success' : result.status === 'skipped' ? 'skipped' : 'failed',
    startedAt: started.toISOString(), finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(), result,
    error: result.status === 'failed' ? result.summary : undefined,
  };
}
