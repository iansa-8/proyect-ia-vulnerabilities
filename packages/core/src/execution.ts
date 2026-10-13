/**
 * Contracts for external process execution.
 * Implementations (Node spawn) live in local-agent — never in the frontend.
 * Future providers/validators must depend on CommandExecutionService, not child_process.
 */

export interface CommandRequest {
  command: string;
  args?: string[];
  cwd: string;
  /** Undefined explicitly removes an inherited variable from the child. */
  env?: Record<string, string | undefined>;
  /** Optional stdin payload. It is never copied into CommandResult. */
  stdin?: string;
  /** Sanitized complete lines; bounded by the command output limit. Never persisted. */
  onOutput?: (event: { stream: 'stdout' | 'stderr'; text: string }) => void;
  timeoutMs?: number;
  allowedExitCodes?: number[];
  /**
   * Kill the complete spawned process tree when the command is cancelled or
   * times out. Validators use this for long-running application processes.
   */
  killProcessTree?: boolean;
  /**
   * Optional cancellation. When aborted, the implementation should kill the
   * spawned process.
   */
  signal?: AbortSignal;
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  timedOut: boolean;
  success: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Bounded summary safe to persist (no megabyte stdout). */
export interface CommandResultSummary {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  success: boolean;
  timedOut: boolean;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Short, redacted snippet — never full buffers. */
  stdoutPreview?: string;
  stderrPreview?: string;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_OUTPUT_BYTE_LIMIT = 256 * 1024;

export function toCommandResultSummary(
  result: CommandResult,
  previewMaxChars = 512,
): CommandResultSummary {
  return {
    command: result.command,
    args: result.args,
    cwd: result.cwd,
    exitCode: result.exitCode,
    success: result.success,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutPreview: result.stdout.slice(0, previewMaxChars),
    stderrPreview: result.stderr.slice(0, previewMaxChars),
  };
}
