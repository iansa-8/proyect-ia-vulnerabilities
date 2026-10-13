import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  collectSecretValues,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_OUTPUT_BYTE_LIMIT,
  redactSecretArgs,
  redactSecretsInText,
  type CommandRequest,
  type CommandResult,
} from '@amp/core';
import {
  assertExistingProjectDirectory,
  PathNotFoundError,
  PathValidationError,
  validateProjectPath,
} from '../common/path-validation';

export class CommandExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandExecutionError';
  }
}

/**
 * Single abstraction for OS processes.
 * Pipeline Step → Provider/Validator → CommandExecutionService → spawn → OS.
 *
 * Uses spawn(command, args) without shell:true.
 * Never concatenates "npm run build" as a single command string.
 *
 * Long-running validators may request process-tree termination. On Windows
 * this uses taskkill /T; on POSIX the child is started in its own process group.
 */
@Injectable()
export class CommandExecutionService {
  private readonly logger = new Logger(CommandExecutionService.name);

  async execute(request: CommandRequest): Promise<CommandResult> {
    const args = request.args ?? [];
    const secretValues = collectSecretValues({ ...process.env, ...request.env }, args);
    const startedAt = new Date();
    const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const byteLimit = DEFAULT_OUTPUT_BYTE_LIMIT;
    const allowed = request.allowedExitCodes ?? [0];

    let cwd: string;
    try {
      cwd = validateProjectPath(request.cwd);
      assertExistingProjectDirectory(cwd);
    } catch (err: unknown) {
      const finishedAt = new Date();
      const message =
        err instanceof PathValidationError || err instanceof PathNotFoundError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        command: request.command,
        args: redactSecretArgs(args, secretValues),
        cwd: request.cwd,
        exitCode: null,
        stdout: '',
        stderr: redactSecretsInText(message, secretValues),
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        timedOut: false,
        success: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }

    if (!request.command || request.command.trim() === '') {
      const finishedAt = new Date();
      return {
        command: request.command,
        args: redactSecretArgs(args, secretValues),
        cwd,
        exitCode: null,
        stdout: '',
        stderr: 'Command must not be empty',
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        timedOut: false,
        success: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }

    return new Promise<CommandResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;
      let childKilled = false;
      const emitted = { stdout: 0, stderr: 0 };
      const publish = (stream: 'stdout' | 'stderr', final = false): void => {
        if (!request.onOutput) return;
        const value = stream === 'stdout' ? stdout : stderr;
        const truncated = stream === 'stdout' ? stdoutTruncated : stderrTruncated;
        // Wait for line boundaries so secrets split between chunks are redacted together.
        const end = final && !truncated ? value.length : value.lastIndexOf('\n') + 1;
        if (end <= emitted[stream]) return;
        const text = redactSecretsInText(value.slice(emitted[stream], end), secretValues);
        emitted[stream] = end;
        try { request.onOutput({ stream, text }); } catch { /* Observers must not interrupt execution. */ }
      };

      const env: NodeJS.ProcessEnv = request.env
        ? { ...process.env, ...request.env }
        : { ...process.env };
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete env[key];
      }
      const resolvedCommand = resolveWindowsCommand(request.command, env);

      let child;
      try {
        const isWindowsBatch =
          process.platform === 'win32' &&
          /\.(bat|cmd)$/i.test(resolvedCommand);

        if (isWindowsBatch) {
          const comSpec =
            process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';

          const quoteArg = (value: string): string =>
            `"${value.replace(/"/g, '""')}"`;

          const commandLine = [
            'call',
            quoteArg(resolvedCommand),
            ...args.map(quoteArg),
          ].join(' ');

          child = spawn(comSpec, ['/d', '/c', commandLine], {
            cwd,
            env,
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: true
          });
        } else {
          child = spawn(resolvedCommand, args, {
            cwd,
            env,
            shell: false,
            windowsHide: true,
            detached: request.killProcessTree === true && process.platform !== 'win32',
          });
        }
      } catch (err: unknown) {
        const finishedAt = new Date();
        const message = err instanceof Error ? err.message : String(err);
        resolve({
          command: request.command,
          args: redactSecretArgs(args, secretValues),
          cwd,
          exitCode: null,
          stdout: '',
          stderr: redactSecretsInText(message, secretValues),
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          timedOut: false,
          success: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
        return;
      }

      const finish = (exitCode: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        publish('stdout', true);
        publish('stderr', true);
        clearTimeout(timer);
        if (abortHandler && request.signal) {
          request.signal.removeEventListener('abort', abortHandler);
        }
        const finishedAt = new Date();
        resolve({
          command: request.command,
          args: redactSecretArgs(args, secretValues),
          cwd,
          exitCode,
          stdout: redactSecretsInText(stdout, secretValues),
          stderr: redactSecretsInText(stderr, secretValues),
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          timedOut,
          success:
            !timedOut &&
            exitCode !== null &&
            allowed.includes(exitCode),
          stdoutTruncated,
          stderrTruncated,
        });
      };

      const killChild = (reason: string): void => {
        if (childKilled) {
          return;
        }
        childKilled = true;
        if (reason === 'timeout') {
          this.logger.warn('Killing process (timeout).');
        } else {
          // AbortSignal is used by bounded startup validation to stop the
          // temporary application once readiness has been demonstrated.
          this.logger.debug('Stopping process after an abort signal.');
        }
        if (request.killProcessTree && child.pid) {
          if (process.platform === 'win32') {
            try {
              const killer = spawn(
                process.env.SystemRoot
                  ? `${process.env.SystemRoot}\\System32\\taskkill.exe`
                  : 'taskkill.exe',
                ['/pid', String(child.pid), '/t', '/f'],
                { shell: false, windowsHide: true },
              );
              const fallback = setTimeout(() => {
                try { child.kill(); } catch { /* ignore */ }
              }, 2_000);
              fallback.unref();
              killer.once('close', (code) => {
                clearTimeout(fallback);
                if (code !== 0) {
                  try { child.kill(); } catch { /* ignore */ }
                }
              });
              killer.once('error', () => {
                clearTimeout(fallback);
                try { child.kill(); } catch { /* ignore */ }
              });
              return;
            } catch {
              // Fall through to direct child termination.
            }
          } else {
            try {
              process.kill(-child.pid, 'SIGTERM');
              return;
            } catch {
              // Fall through to direct child termination.
            }
          }
        }
        try {
          child.kill();
        } catch {
          // ignore
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killChild('timeout');
      }, timeoutMs);

      let abortHandler: (() => void) | undefined;
      if (request.signal) {
        if (request.signal.aborted) {
          timedOut = false;
          killChild('abort');
          finish(null);
          return;
        }
        abortHandler = () => {
          killChild('abort');
        };
        request.signal.addEventListener('abort', abortHandler, { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (stdoutTruncated) {
          return;
        }
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        const remaining = byteLimit - stdoutBytes;
        if (buf.length > remaining) {
          stdout += buf.subarray(0, Math.max(0, remaining)).toString('utf8');
          stdoutBytes = byteLimit;
          stdoutTruncated = true;
        } else {
          stdout += buf.toString('utf8');
          stdoutBytes += buf.length;
        }
        publish('stdout');
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (stderrTruncated) {
          return;
        }
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        const remaining = byteLimit - stderrBytes;
        if (buf.length > remaining) {
          stderr += buf.subarray(0, Math.max(0, remaining)).toString('utf8');
          stderrBytes = byteLimit;
          stderrTruncated = true;
        } else {
          stderr += buf.toString('utf8');
          stderrBytes += buf.length;
        }
        publish('stderr');
      });

      if (request.stdin !== undefined) {
        child.stdin?.end(request.stdin);
      } else {
        child.stdin?.end();
      }

      child.on('error', (err: NodeJS.ErrnoException) => {
        const msg =
          err.code === 'ENOENT'
            ? `Command not found: ${request.command}`
            : err.message;
        stderr = stderr ? `${stderr}\n${msg}` : msg;
        finish(null);
      });

      child.on('close', (code) => {
        finish(code);
      });
    });
  }
}

/**
 * node:child_process.spawn does not apply PATHEXT to a bare command on
 * Windows. npm installs command-line tools as .cmd shims, so `opencode`
 * cannot otherwise be launched by the same safe shell:false path used for
 * every other command. Preserve an explicitly configured path unchanged.
 */
function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): string {
  if (
    process.platform !== 'win32' ||
    /[\\/]/.test(command) ||
    path.extname(command) !== ''
  ) {
    return command;
  }

  const pathValue = env.Path ?? env.PATH ?? '';
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of ['.cmd', '.bat', '.exe']) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return command;
}
