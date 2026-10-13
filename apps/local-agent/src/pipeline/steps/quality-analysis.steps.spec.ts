import type {
  PipelineContext,
  QualityConnectionTestResult,
  QualityIssue,
} from '@amp/core';
import type { QualityProvider } from '@amp/providers';
import { SequentialPipelineEngine } from '@amp/pipeline';
import { CompleteStep } from './complete.step';
import { LoadProjectStep } from './load-project.step';
import { CheckCodeIndexStep } from './check-code-index.step';
import { CheckQualityProviderStep } from './check-quality-provider.step';
import { DownloadQualityIssuesStep } from './download-quality-issues.step';
import { CreateQualitySnapshotStep } from './create-quality-snapshot.step';
import { QUALITY_ANALYSIS_DEFINITION } from '../pipeline-definitions';
import type { QualityService } from '../../quality/quality.service';
import type { ProjectIndexRepository } from '../../persistence/project-index.repository';
import type { QualitySnapshotRepository } from '../../persistence/quality-snapshot.repository';
import type { ProjectQualityConfigRepository } from '../../persistence/project-quality-config.repository';

function baseContext(): PipelineContext {
  return {
    runId: 'run-1',
    project: {
      id: 'p1',
      name: 'Demo',
      path: 'C:\\tmp\\demo',
      profile: {
        hasDocker: false,
        hasSonar: true,
        runtime: 'node',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    projectProfile: {
      hasDocker: false,
      hasSonar: true,
      runtime: 'node',
    },
    data: new Map(),
  };
}

describe('Quality analysis pipeline steps', () => {
  const sampleIssues: QualityIssue[] = [
    {
      id: 'I1',
      provider: 'sonar',
      rule: 'java:S1',
      severity: 'MAJOR',
      message: 'msg',
      file: 'A.java',
      line: 1,
    },
  ];

  it('CreateQualitySnapshotStep persists snapshot on success', async () => {
    const create = jest.fn().mockReturnValue({
      id: 'snap-1',
      projectId: 'p1',
      provider: 'sonar',
      createdAt: new Date().toISOString(),
      totalIssues: 1,
      severityCounts: { MAJOR: 1 },
      typeCounts: {},
    });
    const snapshots = {
      create,
    } as unknown as QualitySnapshotRepository;

    const step = new CreateQualitySnapshotStep(snapshots);
    const ctx = baseContext();
    ctx.data.set('quality.issuesPage', {
      total: 1,
      severityCounts: { MAJOR: 1 },
      typeCounts: {},
      issues: sampleIssues,
    });

    const result = await step.execute(ctx);
    expect(result.status).toBe('success');
    expect(create).toHaveBeenCalled();
    expect(ctx.data.get('quality.snapshotId')).toBe('snap-1');
  });

  it('DownloadIssues does not run usefully when connection failed', async () => {
    const getIssues = jest.fn();
    const quality = { getAllIssues: getIssues } as unknown as QualityService;
    const step = new DownloadQualityIssuesStep(quality);
    const ctx = baseContext();
    ctx.data.set('quality.connection', {
      status: 'AUTHENTICATION_FAILED',
    });

    const result = await step.execute(ctx);
    expect(result.status).toBe('failed');
    expect(getIssues).not.toHaveBeenCalled();
  });

  it('CheckQualityProviderStep fails with connection code, no token', async () => {
    const testConnection = jest.fn().mockResolvedValue({
      status: 'AUTHENTICATION_FAILED',
      provider: 'sonar',
      authenticationConfigured: true,
      message: 'Authentication failed',
    } satisfies QualityConnectionTestResult);

    const quality = { testConnection } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue({
        projectId: 'p1',
        provider: 'sonar',
        projectKey: 'demo',
        sonarProjectName: null,
        autoCreateProject: false,
        baseUrlOverride: null,
        updatedAt: new Date().toISOString(),
      }),
    } as unknown as ProjectQualityConfigRepository;

    process.env.SONAR_URL = 'http://sonar.test:9000';
    process.env.SONAR_TOKEN = 'secret-token-value-xyz';

    const step = new CheckQualityProviderStep(quality, configs);
    const result = await step.execute(baseContext());
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Authentication failed');
    expect(JSON.stringify(result)).not.toContain('secret-token-value-xyz');
  });

  it('composed quality-analysis pipeline with fakes (no network)', async () => {
    const indexes = {
      findByProjectId: jest.fn().mockReturnValue({ status: 'stale' }),
    } as unknown as ProjectIndexRepository;

    const testConnection = jest.fn().mockResolvedValue({
      status: 'CONNECTED',
      provider: 'sonar',
      authenticationConfigured: true,
      project: { provider: 'sonar', key: 'demo', name: 'Demo' },
      version: '9.9.8.100196',
    } satisfies QualityConnectionTestResult);

    const getIssues = jest.fn().mockResolvedValue({
      issues: sampleIssues,
      page: 1,
      pageSize: 50,
      total: 1,
      hasMore: false,
      severityCounts: { MAJOR: 1 },
      typeCounts: { CODE_SMELL: 1 },
    });

    const create = jest.fn().mockReturnValue({
      id: 'snap-2',
      projectId: 'p1',
      provider: 'sonar',
      createdAt: new Date().toISOString(),
      totalIssues: 1,
      severityCounts: { MAJOR: 1 },
      typeCounts: { CODE_SMELL: 1 },
    });

    const qualityProvider = {
      testConnection,
    } as unknown as QualityProvider;
    const qualityService = {
      getAllIssues: getIssues,
    } as unknown as QualityService;
    const snapshots = { create } as unknown as QualitySnapshotRepository;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue({
        projectId: 'p1',
        provider: 'sonar',
        projectKey: 'demo',
        sonarProjectName: null,
        autoCreateProject: false,
        baseUrlOverride: 'http://sonar.test:9000',
        updatedAt: new Date().toISOString(),
      }),
    } as unknown as ProjectQualityConfigRepository;

    process.env.SONAR_TOKEN = 'secret-token-value-xyz';

    const engine = new SequentialPipelineEngine();
    engine.registerStep(new LoadProjectStep());
    engine.registerStep({
      id: 'validate-directory',
      name: 'Validate Project',
      async execute(ctx) {
        const started = new Date();
        return {
          stepId: 'validate-directory',
          status: 'success' as const,
          startedAt: started.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 1,
          result: { path: ctx.project.path },
        };
      },
    });
    engine.registerStep(new CheckCodeIndexStep(indexes));
    engine.registerStep(
      new CheckQualityProviderStep(qualityProvider, configs),
    );
    engine.registerStep(new DownloadQualityIssuesStep(qualityService));
    engine.registerStep(new CreateQualitySnapshotStep(snapshots));
    engine.registerStep(new CompleteStep());
    engine.registerDefinition(QUALITY_ANALYSIS_DEFINITION);

    const events: string[] = [];
    const result = await engine.run('quality-analysis', baseContext(), {
      emit: (event) => {
        events.push(event.type);
      },
    });

    expect(result.status).toBe('success');
    expect(create).toHaveBeenCalled();
    expect(getIssues).toHaveBeenCalled();
    expect(events).toContain('pipeline.started');
    expect(events).toContain('step.started');
    expect(events).toContain('step.completed');
    expect(events).toContain('pipeline.completed');
    expect(JSON.stringify(events)).not.toContain('secret-token-value-xyz');
  });
});
