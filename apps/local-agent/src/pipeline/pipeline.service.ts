import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { mergeProjectProfile, type PipelineContext, type PlatformEvent } from '@amp/core';
import type { PipelineEngine, PipelineRunRecord, StepRunRecord } from '@amp/pipeline';
import { EventsGateway } from '../events/events.gateway';
import { PipelineRunRepository } from '../persistence/pipeline-run.repository';
import { ProjectRepository } from '../persistence/project.repository';
import { PIPELINE_ENGINE } from '../providers/tokens';

export interface PipelineDefinitionView {
  id: string;
  name: string;
  description: string;
  rollbackPolicy: string;
  steps: Array<{ stepId: string; name: string }>;
}

export interface PipelineRunView {
  run: PipelineRunRecord;
  steps: StepRunRecord[];
}

@Injectable()
export class PipelineService implements OnModuleInit {
  private readonly activeBaselines = new Set<string>();
  private readonly activeFixApplications = new Set<string>();
  constructor(
    private readonly runs: PipelineRunRepository,
    private readonly projects: ProjectRepository,
    private readonly events: EventsGateway,
    @Inject(PIPELINE_ENGINE) private readonly engine: PipelineEngine,
  ) {}

  onModuleInit(): void {
    this.runs.recoverInterruptedRuns();
  }

  listDefinitions(): PipelineDefinitionView[] {
    return this.engine.getDefinitions().map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      rollbackPolicy: def.rollbackPolicy,
      steps: def.steps.map((ref) => {
        const step = this.engine.getStep(ref.stepId);
        return {
          stepId: ref.stepId,
          name: step?.name ?? ref.stepId,
        };
      }),
    }));
  }

  getRun(runId: string): PipelineRunView {
    const run = this.runs.findById(runId);
    if (!run) {
      throw new NotFoundException(`Pipeline run not found: ${runId}`);
    }
    return {
      run,
      steps: this.runs.listSteps(runId),
    };
  }

  listRuns(): PipelineRunRecord[] {
    return this.runs.list();
  }

  /**
   * Starts and runs a pipeline synchronously for MVP (demo steps are fast).
   * Emits WebSocket events during the run and persists step/run state.
   * Rejects unknown body fields via ValidationPipe (no free-form shell commands).
   */
  async startRun(
    pipelineId: string,
    projectId: string,
    options?: { forceReindex?: boolean; issueId?: string; proposalId?: string; approvedBy?: string; forceAI?: boolean; forceAgent?: boolean },
  ): Promise<PipelineRunView> {
    const definition = this.engine.getDefinition(pipelineId);
    if (!definition) {
      throw new NotFoundException(`Pipeline not found: ${pipelineId}`);
    }

    const project = this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }

    if (!project.profile) {
      throw new BadRequestException(
        'Project has no persisted profile — select/analyze it first',
      );
    }

    if (pipelineId === 'sonar-baseline' && this.activeBaselines.has(projectId)) {
      throw new ConflictException('A Sonar baseline is already running for this project');
    }
    if (pipelineId === 'quality-fix-application' && this.activeFixApplications.has(projectId)) {
      throw new ConflictException('A fix application is already running for this project');
    }
    const run = this.runs.create({
      projectId: project.id,
      pipelineDefinitionId: definition.id,
    });

    const projectProfile = mergeProjectProfile(
      project.profile,
      project.commandOverrides,
    );

    const context: PipelineContext = {
      runId: run.id,
      project,
      projectProfile,
      data: new Map(),
    };

    if (options?.forceReindex === true) {
      context.data.set('forceReindex', true);
    }
    if (options?.issueId) {
      context.data.set('agent.issueId', options.issueId);
    }
    if (options?.proposalId) context.data.set('fix.proposalId', options.proposalId);
    if (options?.approvedBy) context.data.set('fix.approvedBy', options.approvedBy);
    if (options?.forceAI === true) context.data.set('remediation.forceAI', true);
    if (options?.forceAgent === true) context.data.set('fix.forceAgent', true);

    this.runs.updateRun({
      id: run.id,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const emit = (event: PlatformEvent): void => {
      this.events.emitEvent(event);
    };

    if (pipelineId === 'sonar-baseline') this.activeBaselines.add(projectId);
    if (pipelineId === 'quality-fix-application') this.activeFixApplications.add(projectId);
    try {
      const result = await this.engine.run(definition.id, context, {
        emit,
        onStepRecord: async (snap) => {
          this.runs.upsertStep({
            runId: run.id,
            stepId: snap.stepId,
            name: snap.name,
            status: snap.status,
            startedAt: snap.startedAt,
            finishedAt: snap.finishedAt,
            durationMs: snap.durationMs,
            result: snap.result,
            error: snap.error ?? null,
            stepOrder: snap.stepOrder,
          });
        },
      });

      this.runs.updateRun({
        id: run.id,
        status: result.status,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        error: result.error ?? null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.runs.updateRun({
        id: run.id,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
      });
      emit({
        type: 'pipeline.failed',
        timestamp: new Date().toISOString(),
        payload: { runId: run.id, error: message },
      });
    } finally {
      if (pipelineId === 'sonar-baseline') this.activeBaselines.delete(projectId);
      if (pipelineId === 'quality-fix-application') this.activeFixApplications.delete(projectId);
    }
    return this.getRun(run.id);
  }

  getRegisteredStepCount(): number {
    return this.engine.getSteps().length;
  }
}
