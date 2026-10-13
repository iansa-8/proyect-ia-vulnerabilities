import { Inject, Injectable } from '@nestjs/common';
import type {
  PipelineContext,
  PipelineStep,
  PipelineStepResult,
  QualityAnalysisTaskRef,
  QualityProcessingStatus,
} from '@amp/core';
import type { QualityProvider } from '@amp/providers';
import { loadConfig } from '../../config/app-config';
import { ProjectQualityConfigRepository } from '../../persistence/project-quality-config.repository';
import { QUALITY_PROVIDER } from '../../providers/tokens';
import { buildQualityProviderConfig } from '../../quality/quality-config.util';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Polls QualityProvider CE task/activity until success/failed/timeout.
 * Interval and timeout come from config (not hardcoded).
 */
@Injectable()
export class WaitForQualityProcessingStep implements PipelineStep {
  readonly id = 'wait-quality-processing';
  readonly name = 'Wait For Quality Processing';

  constructor(
    @Inject(QUALITY_PROVIDER) private readonly quality: QualityProvider,
    private readonly configs: ProjectQualityConfigRepository,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const started = new Date();
    const startedAt = started.toISOString();
    const cfg = loadConfig().quality;
    const pollMs = cfg.analysisPollIntervalMs;
    const timeoutMs = cfg.analysisTimeoutMs;
    const deadline = started.getTime() + timeoutMs;

    try {
      const stored = this.configs.findByProjectId(context.project.id);
      const built = buildQualityProviderConfig(stored);
      const providerConfig = {
        baseUrl: built.baseUrl,
        projectKey: built.projectKey,
        authToken: built.authToken,
        credentialRef: built.credentialRef,
      };

      let taskId = context.data.get('quality.taskId') as string | undefined;
      const analysis = context.data.get('quality.analysis') as { startedAt?: string; finishedAt?: string } | undefined;
      if (!taskId && (!analysis?.startedAt || !analysis.finishedAt)) {
        throw new Error('Cannot correlate quality processing without task ID or analysis timestamps');
      }
      let last: QualityAnalysisTaskRef | null = null;
      let polls = 0;

      while (Date.now() < deadline) {
        polls += 1;
        if (taskId) {
          last = await this.quality.getAnalysisTask({
            config: providerConfig,
            taskId,
          });
        } else {
          last = await this.quality.getLatestAnalysisActivity({
            config: providerConfig,
            onlyCurrents: true,
          });
          // Never accept an old successful analysis as this run's completion.
          const submitted = Date.parse(last?.submittedAt ?? '');
          if (!Number.isFinite(submitted)
            || submitted < Date.parse(analysis!.startedAt!)
            || submitted > Date.parse(analysis!.finishedAt!)) {
            last = null;
          }
          if (last?.taskId) {
            taskId = last.taskId;
            context.data.set('quality.taskId', taskId);
          }
        }

        if (last) {
          context.data.set('quality.processing', {
            taskId: last.taskId,
            status: last.status,
            analysisId: last.analysisId,
            vendorStatus: last.vendorStatus,
          });

          if (last.status === 'success') {
            const finished = new Date();
            return {
              stepId: this.id,
              status: 'success',
              startedAt,
              finishedAt: finished.toISOString(),
              durationMs: finished.getTime() - started.getTime(),
              result: {
                taskId: last.taskId,
                status: last.status,
                analysisId: last.analysisId,
                polls,
              },
            };
          }

          if (last.status === 'failed' || last.status === 'timeout') {
            const finished = new Date();
            return {
              stepId: this.id,
              status: 'failed',
              startedAt,
              finishedAt: finished.toISOString(),
              durationMs: finished.getTime() - started.getTime(),
              error: last.errorMessage ?? 'Quality processing failed',
              result: {
                taskId: last.taskId,
                status: last.status,
                polls,
              },
            };
          }
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        await sleep(Math.min(pollMs, remaining));
      }

      const finished = new Date();
      context.data.set('quality.processing', {
        taskId,
        status: 'timeout' satisfies QualityProcessingStatus,
        polls,
      });
      return {
        stepId: this.id,
        status: 'failed',
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        error: 'Quality processing timed out',
        result: {
          taskId,
          status: 'timeout',
          lastStatus: last?.status,
          polls,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
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

