export type ValidatorKind = 'build' | 'unit-test' | 'e2e' | 'health-check';

/**
 * Prefer already-split command + args. Validators must never spawn directly;
 * they will inject CommandExecutionService (local-agent) and pass command/args/cwd.
 * The optional string `command` is a legacy whole-line hint — callers must split
 * before execution (never shell:true).
 */
export interface ValidationRequest {
  projectPath: string;
  /** Executable name only (e.g. "npm"), not "npm run build". */
  command?: string;
  args?: string[];
  /** @deprecated Prefer command + args. Kept for Phase 1/2 compatibility. */
  commandLine?: string;
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  success: boolean;
  kind: ValidatorKind;
  summary: string;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  /** Present when a CommandExecutionService was used (future runners). */
  exitCode?: number | null;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

/**
 * Contract for process execution used by validators.
 * The only spawn implementation is CommandExecutionService in local-agent.
 */
export interface CommandExecutor {
  execute(request: {
    command: string;
    args?: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    allowedExitCodes?: number[];
  }): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    success: boolean;
    timedOut: boolean;
    durationMs: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }>;
}

/**
 * Validators run after AI changes.
 * Phase 3: interfaces aligned for CommandExecutionService; no real build/test
 * execution against foreign projects in this phase.
 */
export interface Validator {
  readonly id: string;
  readonly kind: ValidatorKind;
  validate(request: ValidationRequest): Promise<ValidationResult>;
}

export interface BuildValidator extends Validator {
  readonly kind: 'build';
}

export interface UnitTestValidator extends Validator {
  readonly kind: 'unit-test';
}

export interface E2EValidator extends Validator {
  readonly kind: 'e2e';
}

export interface HealthCheckValidator extends Validator {
  readonly kind: 'health-check';
}

/**
 * Illustrative stub: a future BuildValidator would look like:
 *
 *   constructor(private readonly execution: CommandExecutor) {}
 *   async validate(req) {
 *     const result = await this.execution.execute({
 *       command: req.command!, args: req.args ?? [], cwd: req.projectPath,
 *     });
 *     return { success: result.success, kind: 'build', ... };
 *   }
 *
 * It must NOT import child_process / spawn.
 */
export class NotImplementedBuildValidator implements BuildValidator {
  readonly id = 'build';
  readonly kind = 'build' as const;

  async validate(_request: ValidationRequest): Promise<ValidationResult> {
    return {
      success: false,
      kind: 'build',
      summary:
        'BuildValidator not wired in Phase 3 — would delegate to CommandExecutionService',
      durationMs: 0,
    };
  }
}
