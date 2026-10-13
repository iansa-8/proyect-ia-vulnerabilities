import { Test, TestingModule } from '@nestjs/testing';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {
  collectSecretValues,
  DEFAULT_OUTPUT_BYTE_LIMIT,
  redactSecretsInEnv,
  redactSecretsInText,
} from '@amp/core';
import { CommandExecutionService } from './command-execution.service';

describe('CommandExecutionService', () => {
  let service: CommandExecutionService;
  let cwd: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CommandExecutionService],
    }).compile();
    service = module.get(CommandExecutionService);
    cwd = mkdtempSync(path.join(tmpdir(), 'amp-exec-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on OneDrive/Windows
    }
  });

  it('runs a successful command', async () => {
    const result = await service.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      cwd,
      timeoutMs: 10_000,
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('ok');
  });

  it('captures non-zero exitCode as failure', async () => {
    const result = await service.execute({
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd,
      timeoutMs: 10_000,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it('fails controlled when cwd does not exist', async () => {
    const result = await service.execute({
      command: process.execPath,
      args: ['-e', '0'],
      cwd: path.join(cwd, 'missing-dir-xyz'),
      timeoutMs: 5_000,
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('times out a long-running command', async () => {
    const result = await service.execute({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      cwd,
      timeoutMs: 400,
    });
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
  }, 15_000);

  it('cancels a long-running process tree without reporting a timeout', async () => {
    const controller = new AbortController();
    const pending = service.execute({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30_000)'],
      cwd,
      timeoutMs: 10_000,
      signal: controller.signal,
      killProcessTree: true,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.success).toBe(false);
  }, 15_000);

  it('captures stdout', async () => {
    const result = await service.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hello-stdout")'],
      cwd,
    });
    expect(result.stdout).toBe('hello-stdout');
  });

  it('captures stderr', async () => {
    const result = await service.execute({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("hello-stderr")'],
      cwd,
    });
    expect(result.stderr).toBe('hello-stderr');
  });

  it('truncates oversized stdout', async () => {
    const script = `
      const n = ${DEFAULT_OUTPUT_BYTE_LIMIT + 2048};
      process.stdout.write('x'.repeat(n));
    `;
    const scriptPath = path.join(cwd, 'big.js');
    writeFileSync(scriptPath, script, 'utf8');
    const result = await service.execute({
      command: process.execPath,
      args: [scriptPath],
      cwd,
      timeoutMs: 15_000,
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(
      DEFAULT_OUTPUT_BYTE_LIMIT,
    );
  }, 20_000);

  it('utility redacts secrets in env and text', () => {
    const env = { API_TOKEN: 'tokensecret99', NODE_ENV: 'test' };
    expect(redactSecretsInEnv(env).API_TOKEN).toBe('[REDACTED]');
    const secrets = collectSecretValues(env);
    expect(redactSecretsInText('x tokensecret99 y', secrets)).toBe(
      'x [REDACTED] y',
    );
  });

  it('streams complete sanitized lines even when a secret spans chunks', async () => {
    const events: string[] = [];
    const result = await service.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("split-"); setTimeout(() => { process.stdout.write("secret\\n"); process.stderr.write("final split-secret"); }, 50)'],
      env: { TEST_SECRET: 'split-secret' },
      cwd,
      onOutput: ({ text }) => events.push(text),
    });
    expect(result.success).toBe(true);
    expect(events.join('')).toContain('[REDACTED]');
    expect(events.join('')).not.toContain('split-secret');
    expect(events.join('')).toContain('final [REDACTED]');
  });

  it('continues execution when an output observer throws', async () => {
    const result = await service.execute({
      command: process.execPath, args: ['-e', 'console.log("ok")'], cwd,
      onOutput: () => { throw new Error('observer failed'); },
    });
    expect(result.success).toBe(true);
  });

  it('can remove an inherited secret from the child environment', async () => {
    const inherited = process.env.SONAR_TOKEN;
    process.env.SONAR_TOKEN = 'must-not-reach-child';
    try {
      const result = await service.execute({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(String(process.env.SONAR_TOKEN))'],
        cwd,
        env: { SONAR_TOKEN: undefined },
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('undefined');
      expect(JSON.stringify(result)).not.toContain('must-not-reach-child');
    } finally {
      if (inherited === undefined) delete process.env.SONAR_TOKEN;
      else process.env.SONAR_TOKEN = inherited;
    }
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt.each(['bat', 'cmd'])(
    'runs a Windows .%s with spaces without exposing scanner credentials',
    async (extension) => {
      const token = 'fake-scanner-credential-123456';
      const batchPath = path.join(cwd, `scanner fixture.${extension}`);
      writeFileSync(batchPath, '@echo off\r\necho %~1\r\necho %~2 1>&2\r\necho %~3\r\nexit /b 0\r\n');
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = await service.execute({
        command: batchPath,
        args: [`-Dsonar.login=${token}`, `-Dsonar.token=${token}`, '-Dsonar.projectName=Project with spaces'],
        cwd,
        env: { SONAR_TOKEN: undefined },
        timeoutMs: 10_000,
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('-Dsonar.login=[REDACTED]');
      expect(result.stderr).toContain('-Dsonar.token=[REDACTED]');
      expect(result.stdout).toContain('-Dsonar.projectName=Project with spaces');
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify([log.mock.calls, error.mock.calls, warn.mock.calls])).not.toContain(token);
    },
  );

  windowsIt('resolves a bare npm-style .cmd shim from PATH', async () => {
    const shimPath = path.join(cwd, 'opencode.cmd');
    writeFileSync(shimPath, '@echo off\r\necho shim:%~1\r\nexit /b 0\r\n');

    const result = await service.execute({
      command: 'opencode',
      args: ['--version'],
      cwd,
      env: { Path: cwd },
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('shim:--version');
    // The configured command remains stable for diagnostics and persistence.
    expect(result.command).toBe('opencode');
  });

  it('redacts known credentials when cwd validation fails', async () => {
    const token = 'fake-validation-credential-123456';
    const result = await service.execute({
      command: process.execPath,
      args: [`--credential=${token}`, `-Dsonar.login=${token}`],
      cwd: path.join(cwd, 'missing'),
      env: { SONAR_TOKEN: token },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('redacts known credentials when command is empty', async () => {
    const token = 'fake-empty-command-credential-123456';
    const result = await service.execute({
      command: '',
      args: [`--credential=${token}`],
      cwd,
      env: { SONAR_TOKEN: token },
    });
    expect(result.success).toBe(false);
    expect(result.stderr).toBe('Command must not be empty');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('redacts a synchronous spawn exception', async () => {
    const token = 'fake-spawn-credential-123456';
    jest.spyOn(childProcess, 'spawn').mockImplementationOnce(() => {
      throw new Error(`Cannot start scanner with credential ${token}`);
    });
    const result = await service.execute({
      command: process.execPath,
      args: [`-Dsonar.login=${token}`],
      cwd,
      env: { SONAR_TOKEN: token },
    });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('does not log raw spawn errors containing credential arguments', async () => {
    const token = 'fake-missing-command-credential-123456';
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await service.execute({
      command: path.join(cwd, 'missing-executable'),
      args: [`-Dsonar.login=${token}`, `-Dsonar.token=${token}`],
      cwd,
      env: { SONAR_TOKEN: token },
    });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Command not found');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain(token);
  });

  it('redacts sonar.token args and SONAR_TOKEN in stdout', async () => {
    const token = 'sonar-secret-token-abc12345';
    const result = await service.execute({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write("token=${token} -Dsonar.token=${token}")`,
      ],
      cwd,
      env: { SONAR_TOKEN: token },
      timeoutMs: 10_000,
    });
    expect(result.success).toBe(true);
    expect(result.stdout).not.toContain(token);
    expect(result.stdout).toContain('[REDACTED]');

    const withArg = await service.execute({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write("ok")',
        `-Dsonar.token=${token}`,
      ],
      cwd,
      env: { SONAR_TOKEN: token },
      timeoutMs: 10_000,
    });
    expect(withArg.args.some((a) => a.includes(token))).toBe(false);
    expect(
      withArg.args.some((a) => a.startsWith('-Dsonar.token=[REDACTED]')),
    ).toBe(true);
  });
});
