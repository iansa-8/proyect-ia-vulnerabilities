import type {
  PipelineContext,
  QualityAnalysisResult,
  QualityAnalyzer,
  QualityAnalyzerHealth,
  QualityConnectionTestResult,
  QualityIssue,
} from '@amp/core';
import {
  QualityAnalyzerRegistry,
  type QualityProvider,
} from '@amp/providers';
import { SequentialPipelineEngine } from '@amp/pipeline';
import { CompleteStep } from './complete.step';
import { LoadProjectStep } from './load-project.step';
import { CheckQualityProviderStep } from './check-quality-provider.step';
import { EnsureQualityProjectStep } from './ensure-quality-project.step';
import { CheckQualityAnalyzerStep } from './check-quality-analyzer.step';
import { RunQualityAnalysisStep } from './run-quality-analysis.step';
import { WaitForQualityProcessingStep } from './wait-quality-processing.step';
import { DownloadQualityIssuesStep } from './download-quality-issues.step';
import { CreateQualitySnapshotStep } from './create-quality-snapshot.step';
import { SONAR_BASELINE_DEFINITION } from '../pipeline-definitions';
import type { QualityService } from '../../quality/quality.service';
import type { QualitySnapshotRepository } from '../../persistence/quality-snapshot.repository';
import type { ProjectQualityConfigRepository } from '../../persistence/project-quality-config.repository';
import {
  extractSonarTaskId,
  NodeSonarAnalyzer,
} from '../../quality/node-sonar-analyzer';
import type { CommandExecutionService } from '../../execution/command-execution.service';

const TOKEN = 'super-secret-sonar-token-value-xyz';

function baseContext(): PipelineContext {
  return {
    runId: 'run-baseline-1',
    project: {
      id: 'p1',
      name: 'Demo',
      path: 'C:\\tmp\\demo-node',
      profile: {
        hasDocker: false,
        hasSonar: false,
        runtime: 'node',
        framework: 'nestjs',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    projectProfile: {
      hasDocker: false,
      hasSonar: false,
      runtime: 'node',
      framework: 'nestjs',
    },
    data: new Map(),
  };
}

function storedConfig() {
  return {
    projectId: 'p1',
    provider: 'sonar',
    projectKey: 'demo-key',
    sonarProjectName: 'Demo',
    autoCreateProject: false,
    baseUrlOverride: null,
    updatedAt: new Date().toISOString(),
  };
}

describe('EnsureQualityProjectStep', () => {
  it('succeeds when project exists', async () => {
    const ensureProject = jest.fn().mockResolvedValue({
      status: 'PROJECT_EXISTS',
      provider: 'sonar',
      created: false,
      project: { provider: 'sonar', key: 'demo-key', name: 'Demo' },
    });
    const quality = { ensureProject } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue(storedConfig()),
    } as unknown as ProjectQualityConfigRepository;
    process.env.SONAR_URL = 'http://sonar.test:9000';
    process.env.SONAR_TOKEN = TOKEN;

    const step = new EnsureQualityProjectStep(quality, configs);
    const result = await step.execute(baseContext());
    expect(result.status).toBe('success');
    expect(ensureProject).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('fails without create when missing and autoCreate false', async () => {
    const ensureProject = jest.fn().mockResolvedValue({
      status: 'PROJECT_NOT_FOUND',
      provider: 'sonar',
      created: false,
      message: 'Project not found and auto-create is disabled',
    });
    const createProject = jest.fn();
    const quality = {
      ensureProject,
      createProject,
    } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue({
        ...storedConfig(),
        autoCreateProject: false,
      }),
    } as unknown as ProjectQualityConfigRepository;
    process.env.SONAR_URL = 'http://sonar.test:9000';
    process.env.SONAR_TOKEN = TOKEN;

    const step = new EnsureQualityProjectStep(quality, configs);
    const result = await step.execute(baseContext());
    expect(result.status).toBe('failed');
    expect(createProject).not.toHaveBeenCalled();
    expect(ensureProject.mock.calls[0][0].autoCreate).toBe(false);
  });

  it('creates when missing and autoCreate true', async () => {
    const ensureProject = jest.fn().mockResolvedValue({
      status: 'CONNECTED',
      provider: 'sonar',
      created: true,
      project: { provider: 'sonar', key: 'demo-key', name: 'Demo' },
      createdAt: new Date().toISOString(),
    });
    const quality = { ensureProject } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue({
        ...storedConfig(),
        autoCreateProject: true,
      }),
    } as unknown as ProjectQualityConfigRepository;
    process.env.SONAR_URL = 'http://sonar.test:9000';
    process.env.SONAR_TOKEN = TOKEN;

    const step = new EnsureQualityProjectStep(quality, configs);
    const result = await step.execute(baseContext());
    expect(result.status).toBe('success');
    expect(ensureProject.mock.calls[0][0].autoCreate).toBe(true);
    expect((result.result as { created?: boolean }).created).toBe(true);
  });

  it('maps create forbidden', async () => {
    const ensureProject = jest.fn().mockResolvedValue({
      status: 'CREATE_FORBIDDEN',
      provider: 'sonar',
      created: false,
      message: 'Forbidden to create quality project',
    });
    const quality = { ensureProject } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue({
        ...storedConfig(),
        autoCreateProject: true,
      }),
    } as unknown as ProjectQualityConfigRepository;
    process.env.SONAR_URL = 'http://sonar.test:9000';
    process.env.SONAR_TOKEN = TOKEN;

    const step = new EnsureQualityProjectStep(quality, configs);
    const result = await step.execute(baseContext());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Forbidden');
  });

  it('maps auth error', async () => {
    const ensureProject = jest.fn().mockResolvedValue({
      status: 'AUTHENTICATION_FAILED',
      provider: 'sonar',
      created: false,
      message: 'Authentication failed',
    });
    const quality = { ensureProject } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue({
        ...storedConfig(),
        autoCreateProject: true,
      }),
    } as unknown as ProjectQualityConfigRepository;
    process.env.SONAR_URL = 'http://sonar.test:9000';
    process.env.SONAR_TOKEN = TOKEN;

    const step = new EnsureQualityProjectStep(quality, configs);
    const result = await step.execute(baseContext());
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Authentication failed');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('NodeSonarAnalyzer', () => {
  it('supports node and rejects non-node', () => {
    const commands = { execute: jest.fn() } as unknown as CommandExecutionService;
    const analyzer = new NodeSonarAnalyzer(commands);
    expect(analyzer.supports({ runtime: 'node', hasDocker: false, hasSonar: false })).toBe(
      true,
    );
    expect(
      analyzer.supports({ runtime: 'dotnet', hasDocker: false, hasSonar: false }),
    ).toBe(false);
  });

  it('health reports scanner available', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: true,
      timedOut: false,
      exitCode: 0,
      stdout: 'SonarScanner 4.8.0.2856',
      stderr: '',
      args: ['--version'],
    });
    process.env.SONAR_SCANNER_COMMAND = 'sonar-scanner';
    const analyzer = new NodeSonarAnalyzer({
      execute,
    } as unknown as CommandExecutionService);
    const health = await analyzer.health();
    expect(health.available).toBe(true);
    expect(health.version).toBe('4.8.0.2856');
  });

  it('health reports scanner missing', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: false,
      timedOut: false,
      exitCode: null,
      stdout: '',
      stderr: 'Command not found: sonar-scanner',
      args: ['--version'],
    });
    const analyzer = new NodeSonarAnalyzer({
      execute,
    } as unknown as CommandExecutionService);
    const health = await analyzer.health();
    expect(health.available).toBe(false);
  });

  it('extracts task id from fixture stdout and keeps token out of result', async () => {
    const fixtureStdout = [
      'INFO: ANALYSIS SUCCESSFUL, you can find the results at: http://sonar.test:9000/dashboard?id=demo-key',
      'INFO: More about the report processing at http://sonar.test:9000/api/ce/task?id=AYceTaskFixture123',
      `INFO: token leak check ${TOKEN}`,
    ].join('\n');

    const execute = jest.fn().mockResolvedValue({
      success: true,
      timedOut: false,
      exitCode: 0,
      stdout: fixtureStdout,
      stderr: '',
      args: [
        '-Dsonar.projectKey=demo-key',
        '-Dsonar.host.url=http://sonar.test:9000',
      ],
      durationMs: 10,
    });
    process.env.SONAR_URL = 'http://sonar.test:9000';
    process.env.SONAR_TOKEN = TOKEN;
    process.env.SONAR_SCANNER_TIMEOUT_MS = '600000';

    const analyzer = new NodeSonarAnalyzer({
      execute,
    } as unknown as CommandExecutionService);

    const result = await analyzer.analyze({
      projectId: 'p1',
      projectPath: process.cwd(),
      projectProfile: { runtime: 'node', hasDocker: false, hasSonar: false },
      qualityConfig: {
        baseUrl: 'http://sonar.test:9000',
        projectKey: 'demo-key',
        authToken: TOKEN,
      },
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBe('AYceTaskFixture123');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const call = execute.mock.calls[0][0];
    expect(call.args).toEqual(
      expect.arrayContaining([
        expect.stringContaining('-Dsonar.projectKey='),
        expect.stringContaining('-Dsonar.host.url='),
      ]),
    );
    expect(call.args.join(' ')).not.toContain(TOKEN);
    expect(call.env.SONAR_TOKEN).toBe(TOKEN);
  });

  it('stdout without task id → taskId undefined', () => {
    expect(extractSonarTaskId('INFO: ANALYSIS SUCCESSFUL')).toBeUndefined();
  });

  it('analysis exit != 0 fails', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: false,
      timedOut: false,
      exitCode: 1,
      stdout: '',
      stderr: 'scan failed',
      args: [],
    });
    const analyzer = new NodeSonarAnalyzer({
      execute,
    } as unknown as CommandExecutionService);
    const result = await analyzer.analyze({
      projectId: 'p1',
      projectPath: process.cwd(),
      projectProfile: { runtime: 'node', hasDocker: false, hasSonar: false },
      qualityConfig: {
        baseUrl: 'http://sonar.test:9000',
        projectKey: 'demo-key',
        authToken: TOKEN,
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('scan failed');
  });

  it('analysis timeout fails', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: false,
      timedOut: true,
      exitCode: null,
      stdout: '',
      stderr: '',
      args: [],
    });
    const analyzer = new NodeSonarAnalyzer({
      execute,
    } as unknown as CommandExecutionService);
    const result = await analyzer.analyze({
      projectId: 'p1',
      projectPath: process.cwd(),
      projectProfile: { runtime: 'node', hasDocker: false, hasSonar: false },
      qualityConfig: {
        baseUrl: 'http://sonar.test:9000',
        projectKey: 'demo-key',
        authToken: TOKEN,
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Scanner timed out');
  });
});

describe('WaitForQualityProcessingStep', () => {
  it('uses timestamp-correlated CE activity when task ID is missing', async () => {
    const getLatestAnalysisActivity = jest.fn().mockResolvedValue({
      taskId: 'REAL1', status: 'success', submittedAt: '2026-09-23T01:00:05Z',
    });
    const step = new WaitForQualityProcessingStep(
      { getLatestAnalysisActivity } as unknown as QualityProvider,
      { findByProjectId: jest.fn().mockReturnValue(storedConfig()) } as unknown as ProjectQualityConfigRepository,
    );
    const ctx = baseContext();
    ctx.data.set('quality.analysis', { startedAt: '2026-09-23T01:00:00Z', finishedAt: '2026-09-23T01:00:10Z' });
    expect((await step.execute(ctx)).status).toBe('success');
    expect(ctx.data.get('quality.taskId')).toBe('REAL1');
  });
  it('does not reuse a previous successful task when task ID is missing', async () => {
    process.env.SONAR_ANALYSIS_TIMEOUT_MS = '30';
    process.env.SONAR_ANALYSIS_POLL_INTERVAL_MS = '15';
    const step = new WaitForQualityProcessingStep(
      { getLatestAnalysisActivity: jest.fn().mockResolvedValue({
        taskId: 'OLD', status: 'success', submittedAt: '2026-09-22T01:00:00Z',
      }) } as unknown as QualityProvider,
      { findByProjectId: jest.fn().mockReturnValue(storedConfig()) } as unknown as ProjectQualityConfigRepository,
    );
    const ctx = baseContext();
    ctx.data.set('quality.analysis', { startedAt: '2026-09-23T01:00:00Z', finishedAt: '2026-09-23T01:00:10Z' });
    expect((await step.execute(ctx)).status).toBe('failed');
    expect(ctx.data.get('quality.taskId')).toBeUndefined();
  });
  it('stops on API error', async () => {
    const step = new WaitForQualityProcessingStep(
      { getAnalysisTask: jest.fn().mockRejectedValue(new Error('API unavailable')) } as unknown as QualityProvider,
      { findByProjectId: jest.fn().mockReturnValue(storedConfig()) } as unknown as ProjectQualityConfigRepository,
    );
    const ctx = baseContext();
    ctx.data.set('quality.taskId', 'T1');
    expect((await step.execute(ctx)).status).toBe('failed');
  });
  beforeEach(() => {
    process.env.SONAR_ANALYSIS_POLL_INTERVAL_MS = '10';
    process.env.SONAR_ANALYSIS_TIMEOUT_MS = '200';
    process.env.SONAR_URL = 'http://sonar.test:9000';
    process.env.SONAR_TOKEN = TOKEN;
  });

  it('success when task already success', async () => {
    const getAnalysisTask = jest.fn().mockResolvedValue({
      taskId: 'T1',
      status: 'success',
      analysisId: 'A1',
    });
    const quality = { getAnalysisTask } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue(storedConfig()),
    } as unknown as ProjectQualityConfigRepository;
    const step = new WaitForQualityProcessingStep(quality, configs);
    const ctx = baseContext();
    ctx.data.set('quality.taskId', 'T1');
    const result = await step.execute(ctx);
    expect(result.status).toBe('success');
  });

  it('pending then success', async () => {
    const getAnalysisTask = jest
      .fn()
      .mockResolvedValueOnce({
        taskId: 'T1',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        taskId: 'T1',
        status: 'in_progress',
      })
      .mockResolvedValueOnce({
        taskId: 'T1',
        status: 'success',
        analysisId: 'A1',
      });
    const quality = { getAnalysisTask } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue(storedConfig()),
    } as unknown as ProjectQualityConfigRepository;
    const step = new WaitForQualityProcessingStep(quality, configs);
    const ctx = baseContext();
    ctx.data.set('quality.taskId', 'T1');
    const result = await step.execute(ctx);
    expect(result.status).toBe('success');
    expect(getAnalysisTask.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('failed processing', async () => {
    const getAnalysisTask = jest.fn().mockResolvedValue({
      taskId: 'T1',
      status: 'failed',
      errorMessage: 'CE failed',
    });
    const quality = { getAnalysisTask } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue(storedConfig()),
    } as unknown as ProjectQualityConfigRepository;
    const step = new WaitForQualityProcessingStep(quality, configs);
    const ctx = baseContext();
    ctx.data.set('quality.taskId', 'T1');
    const result = await step.execute(ctx);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('CE failed');
  });

  it('timeout', async () => {
    process.env.SONAR_ANALYSIS_TIMEOUT_MS = '40';
    process.env.SONAR_ANALYSIS_POLL_INTERVAL_MS = '15';
    const getAnalysisTask = jest.fn().mockResolvedValue({
      taskId: 'T1',
      status: 'in_progress',
    });
    const quality = { getAnalysisTask } as unknown as QualityProvider;
    const configs = {
      findByProjectId: jest.fn().mockReturnValue(storedConfig()),
    } as unknown as ProjectQualityConfigRepository;
    const step = new WaitForQualityProcessingStep(quality, configs);
    const ctx = baseContext();
    ctx.data.set('quality.taskId', 'T1');
    const result = await step.execute(ctx);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
  });
});

describe('sonar-baseline pipeline with fakes', () => {
  const sampleIssues: QualityIssue[] = [
    {
      id: 'I1',
      provider: 'sonar',
      rule: 'typescript:S1',
      severity: 'MAJOR',
      message: 'msg',
      file: 'src/a.ts',
      line: 1,
    },
  ];

  function buildEngine(opts: {
    ensureStatus?: string;
    ensureCreated?: boolean;
    scannerOk?: boolean;
    analysisOk?: boolean;
    processingOk?: boolean;
  }) {
    const ensureStatus = opts.ensureStatus ?? 'PROJECT_EXISTS';
    const scannerOk = opts.scannerOk ?? true;
    const analysisOk = opts.analysisOk ?? true;
    const processingOk = opts.processingOk ?? true;

    const testConnection = jest.fn().mockResolvedValue({
      status:
        ensureStatus === 'PROJECT_NOT_FOUND' ? 'PROJECT_NOT_FOUND' : 'CONNECTED',
      provider: 'sonar',
      authenticationConfigured: true,
      project:
        ensureStatus === 'PROJECT_NOT_FOUND'
          ? undefined
          : { provider: 'sonar', key: 'demo-key', name: 'Demo' },
      version: '9.9.8.100196',
    } satisfies QualityConnectionTestResult);

    const ensureProject = jest.fn().mockResolvedValue({
      status: ensureStatus,
      provider: 'sonar',
      created: opts.ensureCreated ?? false,
      project:
        ensureStatus === 'PROJECT_NOT_FOUND'
          ? undefined
          : { provider: 'sonar', key: 'demo-key', name: 'Demo' },
      message:
        ensureStatus === 'PROJECT_NOT_FOUND'
          ? 'missing'
          : 'ok',
    });

    const getIssues = jest.fn().mockResolvedValue({
      issues: sampleIssues,
      page: 1,
      pageSize: 50,
      total: 1,
      hasMore: false,
      severityCounts: { MAJOR: 1 },
      typeCounts: {},
    });

    const getAnalysisTask = jest.fn().mockResolvedValue({
      taskId: 'T1',
      status: processingOk ? 'success' : 'failed',
      analysisId: 'A1',
      errorMessage: processingOk ? undefined : 'CE failed',
    });

    const quality = {
      testConnection,
      ensureProject,
      getAnalysisTask,
      getLatestAnalysisActivity: jest.fn(),
    } as unknown as QualityProvider;

    const create = jest.fn().mockReturnValue({
      id: 'snap-1',
      projectId: 'p1',
      provider: 'sonar',
      createdAt: new Date().toISOString(),
      totalIssues: 1,
      severityCounts: { MAJOR: 1 },
      typeCounts: {},
    });
    const snapshots = { create } as unknown as QualitySnapshotRepository;

    const configs = {
      findByProjectId: jest.fn().mockReturnValue({
        ...storedConfig(),
        autoCreateProject: ensureStatus !== 'PROJECT_NOT_FOUND' || Boolean(opts.ensureCreated),
      }),
    } as unknown as ProjectQualityConfigRepository;

    const qualityService = {
      getAllIssues: getIssues,
    } as unknown as QualityService;

    const fakeAnalyzer: QualityAnalyzer = {
      name: 'node-sonar',
      supports: () => true,
      health: async (): Promise<QualityAnalyzerHealth> => ({
        available: scannerOk,
        analyzer: 'node-sonar',
        version: scannerOk ? '4.8.0' : undefined,
        error: scannerOk ? undefined : 'Scanner unavailable',
      }),
      analyze: async (): Promise<QualityAnalysisResult> => {
        if (!analysisOk) {
          return {
            success: false,
            provider: 'node-sonar',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 1,
            error: 'scan failed',
          };
        }
        return {
          success: true,
          provider: 'node-sonar',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 10,
          taskId: 'T1',
        };
      },
    };

    const registry = new QualityAnalyzerRegistry();
    registry.register(fakeAnalyzer);

    process.env.SONAR_URL = 'http://sonar.test:9000';
    process.env.SONAR_TOKEN = TOKEN;
    process.env.SONAR_ANALYSIS_POLL_INTERVAL_MS = '5';
    process.env.SONAR_ANALYSIS_TIMEOUT_MS = '200';

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
    engine.registerStep(new CompleteStep());
    engine.registerStep(new CheckQualityProviderStep(quality, configs));
    engine.registerStep(new EnsureQualityProjectStep(quality, configs));
    engine.registerStep(new CheckQualityAnalyzerStep(registry));
    engine.registerStep(new RunQualityAnalysisStep(registry, configs));
    engine.registerStep(new WaitForQualityProcessingStep(quality, configs));
    engine.registerStep(new DownloadQualityIssuesStep(qualityService));
    engine.registerStep(new CreateQualitySnapshotStep(snapshots));
    engine.registerDefinition(SONAR_BASELINE_DEFINITION);

    return { engine, create, ensureProject, getIssues };
  }

  it('success complete creates snapshot', async () => {
    const { engine, create } = buildEngine({});
    const result = await engine.run('sonar-baseline', baseContext());
    expect(result.status).toBe('success');
    expect(create).toHaveBeenCalled();
  });

  it('creation flow with autoCreate', async () => {
    const { engine, ensureProject, create } = buildEngine({
      ensureStatus: 'CONNECTED',
      ensureCreated: true,
    });
    const result = await engine.run('sonar-baseline', baseContext());
    expect(result.status).toBe('success');
    expect(ensureProject).toHaveBeenCalled();
    expect(create).toHaveBeenCalled();
  });

  it('existing project flow', async () => {
    const { engine, create } = buildEngine({
      ensureStatus: 'PROJECT_EXISTS',
      ensureCreated: false,
    });
    const result = await engine.run('sonar-baseline', baseContext());
    expect(result.status).toBe('success');
    expect(create).toHaveBeenCalled();
  });

  it('scanner failure does not create snapshot', async () => {
    const { engine, create } = buildEngine({ scannerOk: false });
    const result = await engine.run('sonar-baseline', baseContext());
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('analysis execution failure stops processing and download', async () => {
    const { engine, create, getIssues } = buildEngine({ analysisOk: false });
    const result = await engine.run('sonar-baseline', baseContext());
    expect(result.status).toBe('failed');
    expect(getIssues).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('download failure stops snapshot creation', async () => {
    const { engine, create, getIssues } = buildEngine({});
    getIssues.mockRejectedValue(new Error('Incomplete download'));
    expect((await engine.run('sonar-baseline', baseContext())).status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('processing failure does not create success snapshot', async () => {
    const { engine, create } = buildEngine({ processingOk: false });
    const result = await engine.run('sonar-baseline', baseContext());
    expect(result.status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });
});
