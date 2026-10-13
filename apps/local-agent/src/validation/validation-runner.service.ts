import { Injectable } from '@nestjs/common';
import { collectSecretValues, redactSecretsInText } from '@amp/core';
import fs from 'node:fs';
import path from 'node:path';
import { CommandExecutionService } from '../execution/command-execution.service';

export type FixValidationKind = 'build' | 'unit' | 'e2e' | 'startup' | 'health';

export interface FixValidationResult {
  kind: FixValidationKind;
  status: 'passed' | 'failed' | 'skipped';
  required: boolean;
  command?: string;
  exitCode?: number | null;
  durationMs: number;
  summary: string;
  stdout?: string;
  stderr?: string;
}

export interface StartupValidationResult {
  startup: FixValidationResult;
  health: FixValidationResult;
}

@Injectable()
export class ValidationRunnerService {
  constructor(private readonly commands: CommandExecutionService) {}

  async run(input: {
    kind: FixValidationKind;
    projectPath: string;
    commandLine?: string;
    required: boolean;
    timeoutMs?: number;
  }): Promise<FixValidationResult> {
    if (!input.commandLine?.trim()) {
      return {
        kind: input.kind,
        status: input.required ? 'failed' : 'skipped',
        required: input.required,
        durationMs: 0,
        summary: input.required ? 'Required validation command is not configured' : 'Validation command is not configured',
      };
    }
    const parsed = splitCommandLine(input.commandLine);
    if (!parsed.length) {
      return { kind: input.kind, status: 'failed', required: input.required, durationMs: 0, summary: 'Invalid validation command' };
    }
    const executable = resolveExecutable(parsed[0]);
    const result = await this.commands.execute({
      command: executable,
      args: parsed.slice(1),
      cwd: input.projectPath,
      timeoutMs: input.timeoutMs ?? 600_000,
      killProcessTree: true,
    });
    const secrets = collectSecretValues(process.env);
    return {
      kind: input.kind,
      status: result.success ? 'passed' : 'failed',
      required: input.required,
      command: input.commandLine,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      summary: result.success ? `${input.kind} validation passed` : result.timedOut ? `${input.kind} validation timed out` : `${input.kind} validation failed`,
      stdout: redactSecretsInText(result.stdout, secrets).slice(-12_000),
      stderr: redactSecretsInText(result.stderr, secrets).slice(-12_000),
    };
  }

  async runStartup(input: {
    projectPath: string;
    commandLine?: string;
    required: boolean;
    healthUrl?: string;
    healthRequired: boolean;
    timeoutMs?: number;
    readinessMs?: number;
    pollIntervalMs?: number;
  }): Promise<StartupValidationResult> {
    const healthMissing = (): FixValidationResult => ({
      kind: 'health',
      status: input.healthRequired ? 'failed' : 'skipped',
      required: input.healthRequired,
      durationMs: 0,
      summary: input.healthRequired
        ? 'Required health endpoint is not configured'
        : 'Health endpoint is not configured for this project',
    });
    if (!input.commandLine?.trim()) {
      return {
        startup: {
          kind: 'startup', status: input.required ? 'failed' : 'skipped', required: input.required, durationMs: 0,
          summary: input.required ? 'Required startup command is not configured' : 'Startup command is not configured',
        },
        health: healthMissing(),
      };
    }
    const parsed = splitCommandLine(input.commandLine);
    if (!parsed.length) {
      return {
        startup: { kind: 'startup', status: 'failed', required: input.required, durationMs: 0, summary: 'Invalid startup command' },
        health: healthMissing(),
      };
    }

    const timeoutMs = input.timeoutMs ?? 60_000;
    const readinessMs = Math.max(250, input.readinessMs ?? 5_000);
    const pollIntervalMs = Math.max(250, input.pollIntervalMs ?? 1_000);
    const startedAt = Date.now();
    const controller = new AbortController();
    const readinessController = new AbortController();
    const commandPromise = this.commands.execute({
      command: resolveExecutable(parsed[0]),
      args: parsed.slice(1),
      cwd: input.projectPath,
      timeoutMs,
      signal: controller.signal,
      killProcessTree: true,
    });
    const processOutcome = commandPromise.then((result) => ({ type: 'process' as const, result }));
    let healthDurationMs = 0;

    const readinessOutcome = input.healthUrl?.trim()
      ? this.waitForHealth(input.healthUrl.trim(), timeoutMs, pollIntervalMs, readinessController.signal).then((health) => {
          healthDurationMs = health.durationMs;
          return { type: 'ready' as const, health };
        })
      : delay(readinessMs, readinessController.signal).then(() => ({ type: 'ready' as const, health: undefined }));
    const outcome = await Promise.race([processOutcome, readinessOutcome]);

    if (outcome.type === 'process') {
      readinessController.abort();
      const result = outcome.result;
      const secrets = collectSecretValues(process.env);
      return {
        startup: {
          kind: 'startup', status: 'failed', required: input.required, command: input.commandLine,
          exitCode: result.exitCode, durationMs: result.durationMs,
          summary: result.timedOut ? 'Startup readiness timed out' : 'Startup process exited before readiness',
          stdout: redactSecretsInText(result.stdout, secrets).slice(-12_000),
          stderr: redactSecretsInText(result.stderr, secrets).slice(-12_000),
        },
        health: input.healthUrl?.trim()
          ? { kind: 'health', status: 'failed', required: input.healthRequired, durationMs: healthDurationMs, summary: 'Health endpoint did not become ready' }
          : healthMissing(),
      };
    }

    controller.abort();
    const stopped = await commandPromise;
    const secrets = collectSecretValues(process.env);
    const startup: FixValidationResult = {
      kind: 'startup', status: 'passed', required: input.required, command: input.commandLine,
      exitCode: stopped.exitCode, durationMs: Date.now() - startedAt,
      summary: input.healthUrl?.trim()
        ? 'Startup reached the configured health endpoint and was stopped cleanly'
        : `Startup remained running for ${readinessMs}ms and was stopped cleanly`,
      stdout: redactSecretsInText(stopped.stdout, secrets).slice(-12_000),
      stderr: redactSecretsInText(stopped.stderr, secrets).slice(-12_000),
    };
    const health: FixValidationResult = outcome.health
      ? {
          kind: 'health', status: outcome.health.ok ? 'passed' : 'failed', required: input.healthRequired,
          durationMs: outcome.health.durationMs,
          summary: outcome.health.ok
            ? `Health endpoint responded with HTTP ${outcome.health.status}`
            : 'Health endpoint did not become ready',
        }
      : healthMissing();
    return { startup, health };
  }

  private async waitForHealth(
    url: string,
    timeoutMs: number,
    pollIntervalMs: number,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; status?: number; durationMs: number }> {
    const startedAt = Date.now();
    while (!signal.aborted && Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(5_000, pollIntervalMs))]) });
        if (response.ok) return { ok: true, status: response.status, durationMs: Date.now() - startedAt };
      } catch {
        // The application may still be starting; retry until the bounded timeout.
      }
      await delay(pollIntervalMs, signal);
    }
    return { ok: false, durationMs: Date.now() - startedAt };
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function splitCommandLine(value: string): string[] {
  const result: string[] = [];
  const expression = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value)) !== null) result.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'])/g, '$1'));
  return result;
}

export function resolveExecutable(value: string): string {
  if (process.platform === 'win32' && /^(npm|npx|yarn|pnpm|bun)$/i.test(value)) {
    const executable = `${value}.cmd`;
    const searchPaths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const directory of searchPaths) {
      // A package-manager shim inside the analyzed repository can make `%~dp0`
      // resolve against that repository. Validators must use the installed tool.
      if (/[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(directory)) continue;
      const candidate = path.resolve(directory, executable);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return executable;
  }
  return value;
}
