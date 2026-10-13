import type { CommandResult, PipelineContext } from '@amp/core';
import type { CommandExecutionService } from '../execution/command-execution.service';
import { ValidationRunnerService, type FixValidationKind, resolveExecutable, splitCommandLine } from './validation-runner.service';
import { HealthValidationStep, StartupValidationStep } from '../pipeline/steps/fix-validation.steps';

function command(success: boolean): CommandResult {
  const now = new Date();
  return { command: 'npm', args: [], cwd: 'C:\\repo', exitCode: success ? 0 : 1, stdout: success ? 'ok' : '', stderr: success ? '' : 'failed', startedAt: now, finishedAt: now, durationMs: 5, timedOut: false, success, stdoutTruncated: false, stderrTruncated: false };
}

describe('ValidationRunnerService', () => {
  it('splits configured commands without using a shell', () => {
    expect(splitCommandLine('npm run test -- --runInBand "a b"')).toEqual(['npm', 'run', 'test', '--', '--runInBand', 'a b']);
  });

  it('resolves Windows package managers to an installed absolute shim', () => {
    const executable = resolveExecutable('npm');
    if (process.platform === 'win32') {
      expect(executable).toMatch(/^[A-Za-z]:[\\/].*npm\.cmd$/i);
      expect(executable).not.toMatch(/[\\/]node_modules[\\/]\.bin[\\/]/i);
    } else {
      expect(executable).toBe('npm');
    }
  });

  it.each<FixValidationKind>(['build', 'unit', 'e2e'])('%s maps command pass and failure', async (kind) => {
    const execute = jest.fn().mockResolvedValueOnce(command(true)).mockResolvedValueOnce(command(false));
    const runner = new ValidationRunnerService({ execute } as unknown as CommandExecutionService);
    await expect(runner.run({ kind, projectPath: 'C:\\repo', commandLine: 'npm run test', required: true })).resolves.toMatchObject({ status: 'passed', exitCode: 0 });
    await expect(runner.run({ kind, projectPath: 'C:\\repo', commandLine: 'npm run test', required: true })).resolves.toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('distinguishes optional skip from required missing command', async () => {
    const runner = new ValidationRunnerService({} as CommandExecutionService);
    await expect(runner.run({ kind: 'e2e', projectPath: 'C:\\repo', required: false })).resolves.toMatchObject({ status: 'skipped' });
    await expect(runner.run({ kind: 'build', projectPath: 'C:\\repo', required: true })).resolves.toMatchObject({ status: 'failed' });
  });

  it('startup waits for readiness, stops the process, and leaves health skipped when unconfigured', async () => {
    const execute = jest.fn((_request: { signal?: AbortSignal }) => new Promise<CommandResult>((resolve) => {
      _request.signal?.addEventListener('abort', () => resolve(command(false)), { once: true });
    }));
    const runner = new ValidationRunnerService({ execute } as unknown as CommandExecutionService);
    const context = { project: { path: 'C:\\repo' }, projectProfile: { startCommand: 'npm run start' }, data: new Map() } as unknown as PipelineContext;
    context.data.set('config:validate-fix-startup', { required: true, readinessMs: 10 });
    await expect(new StartupValidationStep(runner).execute(context)).resolves.toMatchObject({ status: 'success' });
    await expect(new HealthValidationStep(runner).execute(context)).resolves.toMatchObject({ status: 'skipped' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ killProcessTree: true }));
  });

  it('startup fails when the process exits before readiness', async () => {
    const runner = new ValidationRunnerService({ execute: jest.fn().mockResolvedValue(command(false)) } as unknown as CommandExecutionService);
    const context = { project: { path: 'C:\\repo' }, projectProfile: { startCommand: 'npm run start' }, data: new Map() } as unknown as PipelineContext;
    context.data.set('config:validate-fix-startup', { required: true, readinessMs: 100 });
    await expect(new StartupValidationStep(runner).execute(context)).resolves.toMatchObject({ status: 'failed' });
  });

  it('startup reports a configured health endpoint pass while the process is running', async () => {
    const execute = jest.fn((request: { signal?: AbortSignal }) => new Promise<CommandResult>((resolve) => {
      request.signal?.addEventListener('abort', () => resolve(command(false)), { once: true });
    }));
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    const runner = new ValidationRunnerService({ execute } as unknown as CommandExecutionService);
    const result = await runner.runStartup({
      projectPath: 'C:\\repo', commandLine: 'npm run start', required: true,
      healthUrl: 'http://127.0.0.1:3000/health', healthRequired: true,
      timeoutMs: 1_000, pollIntervalMs: 10,
    });
    expect(result.startup.status).toBe('passed');
    expect(result.health).toMatchObject({ status: 'passed', required: true });
  });

  it('does not fail an optional configured health check', async () => {
    const runner = new ValidationRunnerService({} as unknown as CommandExecutionService);
    const context = { project: { path: 'C:\\repo' }, projectProfile: {}, data: new Map() } as unknown as PipelineContext;
    context.data.set('config:validate-fix-health', { required: false });
    context.data.set('fix.startupHealthResult', {
      kind: 'health', status: 'failed', required: false, durationMs: 1, summary: 'not ready',
    });

    await expect(new HealthValidationStep(runner).execute(context)).resolves.toMatchObject({
      status: 'skipped',
      result: { status: 'skipped' },
    });
  });

  it('startup and health distinguish missing optional configuration', async () => {
    const runner = new ValidationRunnerService({} as CommandExecutionService);
    await expect(runner.runStartup({
      projectPath: 'C:\\repo', required: false, healthRequired: false,
    })).resolves.toMatchObject({ startup: { status: 'skipped' }, health: { status: 'skipped' } });
  });
});
