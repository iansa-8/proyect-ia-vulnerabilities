import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  redactSecretsInText,
  collectSecretValues,
  type AgentErrorCode,
  type AgentCodeContext,
  type AgentExecutionTrace,
  type AgentHealth,
  type AgentProposal,
  type AgentResult,
  type AgentTask,
  type CommandResult,
} from '@amp/core';
import type { AgentProvider } from '@amp/providers';
import { loadConfig } from '../config/app-config';
import { CommandExecutionService } from '../execution/command-execution.service';
import { ProposeFixPromptBuilder } from './propose-fix-prompt.builder';
import { ApplyFixPromptBuilder } from './apply-fix-prompt.builder';
import { WorkingTreeGuardService } from './working-tree-guard.service';

type ProposalWire = Omit<AgentProposal, 'provider' | 'taskId' | 'agentSuggestedRisk'> & {
  risk: AgentProposal['agentSuggestedRisk'];
};

@Injectable()
export class OpenCodeAgentProvider implements AgentProvider {
  private readonly logger = new Logger(OpenCodeAgentProvider.name);
  readonly name = 'opencode';
  readonly capabilities = ['apply-fix'] as const;

  constructor(
    private readonly commands: CommandExecutionService,
    private readonly prompts: ProposeFixPromptBuilder,
    private readonly applyPrompts: ApplyFixPromptBuilder,
    private readonly workingTree: WorkingTreeGuardService,
  ) {}

  async health(): Promise<AgentHealth> {
    const config = loadConfig().agent;
    try {
      await this.prepareOpenCodeHome(config.opencodeConfigHome);
    } catch {
      return {
        available: false,
        provider: this.name,
        capabilities: [...this.capabilities],
        error: 'OpenCode runtime directory is unavailable',
      };
    }
    const result = await this.commands.execute({
      command: config.opencodeCommand,
      args: ['--version'],
      cwd: config.monorepoRoot,
      env: this.openCodeEnv(config.opencodeConfigHome),
      timeoutMs: Math.min(config.opencodeTimeoutMs, 30_000),
    });
    const version = /(?:opencode\s+)?v?(\d+\.\d+\.\d+(?:[-+.\w]*)?)/i
      .exec(result.stdout)?.[1];
    const available = result.success && Boolean(version);
    
    return {
      available,
      provider: this.name,
      version,
      capabilities: [...this.capabilities],
      error: available ? undefined : describeHealthFailure(config.opencodeCommand, result),
    };
  }

  execute(task: AgentTask): Promise<AgentResult> {
    if (task.type === 'apply-fix') return this.applyFix(task);
    if (task.type !== 'propose-fix') {
      return Promise.resolve(this.failure(
        'UNSUPPORTED_CAPABILITY',
        `Capability ${task.type} is not supported`,
      ));
    }
    return this.proposeFix(task);
  }

  async applyFix(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    if (
      task.type !== 'apply-fix' || !task.id || !task.issue || !task.project ||
      !task.proposalId || !task.approvedProposal || !task.allowedFiles?.length
    ) {
      return this.failure('INVALID_AGENT_RESPONSE', 'Invalid apply-fix task');
    }
    const health = await this.health();
    if (!health.available) return this.failure('AGENT_UNAVAILABLE', health.error ?? 'OpenCode unavailable');
    const config = loadConfig().agent;
    const prompt = this.applyPrompts.build(task);
    const executionTrace = buildExecutionTrace(task.context as AgentCodeContext, prompt, config.promptPreviewMaxChars);
    const command = await this.runWithPromptAttachment(
      task.projectPath,
      config.opencodeCommand,
      config.opencodeConfigHome,
      config.opencodeTimeoutMs,
      prompt,
      true,
      'Read the attached task instructions and apply them. Return only valid JSON with summary (string) and warnings (string array).',
      task.id,
    );
    const durationMs = Date.now() - started;
    if (command.timedOut) return { ...this.failure('AGENT_TIMEOUT', `OpenCode execution timed out: ${extractExecutionError(command.stdout, command.stderr)}`), providerVersion: health.version, durationMs, executionTrace };
    if (!command.success) {
      return { ...this.failure('AGENT_EXECUTION_FAILED', extractExecutionError(command.stdout, command.stderr)), providerVersion: health.version, durationMs, executionTrace };
    }
    if (command.stdoutTruncated || command.stderrTruncated || !command.stdout.trim()) {
      return { ...this.failure('INVALID_AGENT_RESPONSE', 'OpenCode response is empty or truncated'), providerVersion: health.version, durationMs, executionTrace };
    }
    try {
      const wire = parseApplyResult(command.stdout);
      return {
        success: true,
        summary: wire.summary,
        touchedFiles: [],
        provider: this.name,
        providerVersion: health.version,
        durationMs,
        output: JSON.stringify({ warnings: wire.warnings }),
        executionTrace,
      };
    } catch (error) {
      this.logger.warn(`[ApplyFix] Unable to parse OpenCode response: ${error instanceof Error ? error.message : String(error)}`);
      // A successful OpenCode process may emit only tool/session events. Do not
      // make the safety decision depend on its conversational response: the
      // following pipeline steps require a real Git delta, enforce allowed
      // files and run the configured validations.
      return {
        success: true,
        summary: 'OpenCode completed; the platform will verify the resulting changes.',
        touchedFiles: [],
        provider: this.name,
        providerVersion: health.version,
        durationMs,
        output: JSON.stringify({
          warnings: ['OpenCode did not return a structured completion message.'],
        }),
        executionTrace,
      };
    }
  }

  async proposeFix(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    if (task.type !== 'propose-fix' || !task.id || !task.issue || !task.project) {
      return this.failure('INVALID_AGENT_RESPONSE', 'Invalid propose-fix task');
    }
    const health = await this.health();
    if (!health.available) {
      return this.failure('AGENT_UNAVAILABLE', health.error ?? 'OpenCode unavailable');
    }

    let before;
    try {
      before = await this.workingTree.capture(task.projectPath);
    } catch {
      return this.failure('CONTEXT_UNAVAILABLE', 'Unable to capture repository baseline');
    }

    const config = loadConfig().agent;
    const prompt = this.prompts.build(task);
    const executionTrace = buildExecutionTrace(
      task.context as AgentCodeContext,
      prompt,
      config.promptPreviewMaxChars,
    );
    const command = await this.runWithPromptAttachment(
      task.projectPath,
      config.opencodeCommand,
      config.opencodeConfigHome,
      config.opencodeTimeoutMs,
      prompt,
      false,
      'Read the attached task instructions. Do not modify files. Return only the requested JSON proposal.',
      task.id,
    );

    let after;
    try {
      after = await this.workingTree.capture(task.projectPath);
    } catch {
      return this.failure('CONTEXT_UNAVAILABLE', 'Unable to verify repository state');
    }
    const writeDetection = {
      unchanged: this.workingTree.unchanged(before, after),
      beforeFingerprint: before.fingerprint,
      afterFingerprint: after.fingerprint,
    };
    if (!writeDetection.unchanged) {
      return {
        ...this.failure('AGENT_WRITE_DETECTED', 'Repository changed during agent execution'),
        providerVersion: health.version,
        durationMs: Date.now() - started,
        writeDetection,
        executionTrace,
      };
    }
    if (command.timedOut) {
      return {
        ...this.failure('AGENT_TIMEOUT', 'OpenCode execution timed out'),
        providerVersion: health.version,
        durationMs: Date.now() - started,
        writeDetection,
        executionTrace,
      };
    }
    if (!command.success) {
      return {
        ...this.failure(
          'AGENT_EXECUTION_FAILED',
          extractExecutionError(command.stdout, command.stderr),
        ),
        providerVersion: health.version,
        durationMs: Date.now() - started,
        writeDetection,
        executionTrace,
      };
    }
    if (command.stdoutTruncated || command.stderrTruncated || !command.stdout.trim()) {
      return {
        ...this.failure('INVALID_AGENT_RESPONSE', 'OpenCode response is empty or truncated'),
        providerVersion: health.version,
        durationMs: Date.now() - started,
        writeDetection,
        executionTrace,
      };
    }
    try {
      const wire = parseProposal(command.stdout);
      const proposal: AgentProposal = {
        provider: this.name,
        taskId: task.id,
        summary: wire.summary,
        diagnosis: wire.diagnosis ?? undefined,
        proposedChanges: wire.proposedChanges.map((change) => ({
          file: change.file,
          description: change.description,
          rationale: change.rationale ?? undefined,
        })),
        affectedFiles: wire.affectedFiles,
        agentSuggestedRisk: wire.risk,
        validationPlan: wire.validationPlan,
        assumptions: wire.assumptions,
        warnings: wire.warnings,
        rawResponseAvailable: false,
      };
      return {
        success: true,
        summary: proposal.summary,
        touchedFiles: [],
        provider: this.name,
        providerVersion: health.version,
        durationMs: Date.now() - started,
        proposal,
        writeDetection,
        executionTrace,
      };
    } catch {
      return {
        ...this.failure('INVALID_AGENT_RESPONSE', 'OpenCode returned an invalid structured proposal'),
        providerVersion: health.version,
        durationMs: Date.now() - started,
        writeDetection,
        executionTrace,
      };
    }
  }

  private failure(code: AgentErrorCode, message: string): AgentResult {
    return {
      success: false,
      summary: message,
      touchedFiles: [],
      provider: this.name,
      error: { code, message },
    };
  }

  private openCodeEnv(configHome: string): NodeJS.ProcessEnv {
    // The user-level database was created by another OpenCode client and is
    // incompatible with this CLI version. Keep it untouched and give the
    // platform its own explicitly configured database.
    const runtimeHome = this.runtimeHome(configHome);
    const root = path.parse(runtimeHome).root;
    const homePath = runtimeHome.slice(root.length).replace(/\//g, '\\');
    return {
      XDG_CONFIG_HOME: configHome,
      OPENCODE_CONFIG_DIR: configHome,
      OPENCODE_DB: path.join(configHome, 'opencode-platform.db'),
      HOME: runtimeHome,
      USERPROFILE: runtimeHome,
      HOMEDRIVE: root.replace(/[\\/]+$/, ''),
      HOMEPATH: `\\${homePath}`,
    };
  }

  private runtimeHome(configHome: string): string {
    return path.join(configHome, 'runtime-home');
  }

  private async prepareOpenCodeHome(configHome: string): Promise<void> {
    await fs.mkdir(configHome, { recursive: true });
    const runtimeHome = this.runtimeHome(configHome);
    await Promise.all([
      fs.mkdir(runtimeHome, { recursive: true }),
      fs.mkdir(path.join(runtimeHome, '.local', 'share', 'opencode', 'log'), { recursive: true }),
      fs.mkdir(path.join(runtimeHome, '.local', 'state', 'opencode'), { recursive: true }),
    ]);
  }

  /**
   * npm's Windows shim runs through cmd.exe, whose command line limit is much
   * shorter than the indexed context prompt. OpenCode supports attachments, so
   * pass a short instruction on the command line and keep the full prompt in a
   * temporary file outside the analyzed repository.
   */
  private async runWithPromptAttachment(
    projectPath: string,
    command: string,
    configHome: string,
    timeoutMs: number,
    prompt: string,
    allowWrites: boolean,
    instruction: string,
    taskId: string,
  ): Promise<CommandResult> {
    await this.prepareOpenCodeHome(configHome);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amp-opencode-'));
    const promptPath = path.join(directory, 'task.md');
    const started = Date.now();
    let lastOutputAt: number | undefined;
    const safeLog = (event: string, data: unknown) => this.logger.log(
      redactSecretsInText(JSON.stringify({ taskId, event, data }), collectSecretValues(process.env)),
    );
    const safePrompt = redactSecretsInText(prompt, collectSecretValues(process.env));
    const previewLimit = loadConfig().agent.promptPreviewMaxChars;
    safeLog('request', { command, cwd: projectPath, timeoutMs, allowWrites, instruction,
      promptChars: prompt.length, promptSha256: createHash('sha256').update(prompt).digest('hex'),
      promptPreview: safePrompt.slice(0, previewLimit), promptPreviewTruncated: safePrompt.length > previewLimit,
      configHome });
    const heartbeat = setInterval(() => safeLog('waiting', {
      elapsedMs: Date.now() - started,
      sinceLastOutputMs: lastOutputAt === undefined ? null : Date.now() - lastOutputAt,
      outputReceived: lastOutputAt !== undefined,
    }), 15_000);
    heartbeat.unref();
    try {
      await fs.writeFile(promptPath, prompt, 'utf8');
      const result = await this.commands.execute({
        command,
        args: [
          'run',
          '--format', 'json',
          '--print-logs', '--log-level', 'INFO',
          '--dir', projectPath,
          `--file=${promptPath}`,
          ...(allowWrites ? ['--auto'] : []),
          '--',
          instruction,
        ],
        cwd: projectPath,
        env: this.openCodeEnv(configHome),
        timeoutMs,
        killProcessTree: true,
        onOutput: ({ stream, text }) => {
          lastOutputAt = Date.now();
          safeLog(stream, text);
        },
      });
      safeLog('completed', { success: result.success, exitCode: result.exitCode, timedOut: result.timedOut,
        durationMs: result.durationMs, stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
        stderrTail: sanitizeDetail(result.stderr),
      });
      return result;
    } finally {
      clearInterval(heartbeat);
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

function describeHealthFailure(command: string, result: CommandResult): string {
  const noProcessOutput = !result.stdout.trim() && !result.stderr.trim();
  const terminatedBeforeStartup = noProcessOutput
    && (result.exitCode === -1 || result.exitCode === 4_294_967_295);
  if (terminatedBeforeStartup) {
    return `OpenCode fue terminado antes de iniciar (exitCode=${result.exitCode}). `
      + `La protección endpoint o una política de ejecución puede estar bloqueando ${command}.`;
  }
  return `OpenCode CLI unavailable (success=${result.success}, exitCode=${result.exitCode}, `
    + `stdout=${result.stdout.slice(0, 100)}, stderr=${result.stderr.slice(0, 100)})`;
}

function buildExecutionTrace(
  context: AgentCodeContext,
  prompt: string,
  previewLimit: number,
): AgentExecutionTrace {
  const snippets = context.snippets ?? [];
  return {
    indexProvider: context.indexProvider,
    indexState: context.indexState,
    targetSymbol: context.targetSymbol,
    filesIncluded: context.files ?? [],
    symbolsIncluded: context.symbols?.length ?? 0,
    snippetsIncluded: snippets.length,
    snippetChars: snippets.reduce(
      (total, snippet) => total + snippet.content.length,
      0,
    ),
    promptChars: prompt.length,
    promptSha256: createHash('sha256').update(prompt).digest('hex'),
    promptPreview: redactSecretsInText(prompt, collectSecretValues(process.env)).slice(0, previewLimit),
    promptPreviewTruncated: prompt.length > previewLimit,
  };
}

function parseProposal(stdout: string): ProposalWire {
  for (const candidate of parseStructuredObjects(stdout)) {
    const parsed = candidate as Partial<ProposalWire>;
    if (
      typeof parsed.summary === 'string' &&
      Array.isArray(parsed.proposedChanges) &&
      Array.isArray(parsed.affectedFiles) &&
      ['low', 'medium', 'high', 'unknown'].includes(String(parsed.risk)) &&
      Array.isArray(parsed.validationPlan) &&
      parsed.proposedChanges.every((change) =>
        Boolean(change) && typeof change.file === 'string' && typeof change.description === 'string')
    ) {
      return parsed as ProposalWire;
    }
  }
  throw new Error('invalid proposal');
}

export function parseApplyResult(stdout: string): { summary: string; warnings: string[] } {
  for (const candidate of parseStructuredObjects(stdout)) {
    for (const value of applyResultCandidates(candidate)) {
      const summary = firstNonEmptyString(value.summary, value.message, value.result, value.resumen);
      const warnings = normalizeWarnings(value.warnings ?? value.warning ?? value.advertencias);
      if (summary && warnings) return { summary, warnings };
    }
  }

  // OpenCode does not currently support an output schema for `run`. Some
  // models therefore return a final assistant message instead of the JSON we
  // requested. Treat that text only as the execution summary. The pipeline
  // still verifies the actual Git delta, allowed-file scope and validations.
  const text = extractFinalAssistantText(stdout);
  if (text) return { summary: text, warnings: [] };
  throw new Error('invalid apply result');
}

function applyResultCandidates(value: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [value];
  for (const key of ['applyResult', 'apply_result', 'result', 'data', 'output']) {
    const nested = value[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      candidates.push(nested as Record<string, unknown>);
    }
  }
  return candidates;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function normalizeWarnings(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

function extractFinalAssistantText(stdout: string): string | undefined {
  const texts: string[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      collectAssistantTexts(event, texts);
    } catch {
      // OpenCode JSON mode may still include a final plain-text line.
      const value = line.trim();
      if (value && !/^timestamp=/i.test(value)) texts.push(value);
    }
  }
  const finalText = texts.map((value) => value.trim()).filter(Boolean).at(-1);
  if (!finalText || finalText.length > 4_000) return undefined;
  return finalText;
}

function collectAssistantTexts(value: unknown, texts: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const type = String(record.type ?? '').toLowerCase();
  const part = record.part;
  if (type === 'text' && part && typeof part === 'object' && !Array.isArray(part)) {
    const text = (part as Record<string, unknown>).text;
    if (typeof text === 'string') texts.push(text);
  }
  if ((type === 'assistant' || type === 'message') && typeof record.content === 'string') {
    texts.push(record.content);
  }
}

/**
 * OpenCode's JSON mode streams events rather than returning Codex's
 * item.completed envelope. Look through all string fields and accept the last
 * JSON object returned by the agent, while retaining support for a direct JSON
 * response for non-streaming runners.
 */
function parseStructuredObjects(stdout: string): Record<string, unknown>[] {
  const candidates: string[] = [stdout.trim()];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    candidates.push(line);
    try {
      collectJsonStrings(JSON.parse(line), candidates);
    } catch {
      // A non-JSON diagnostics line cannot contain the structured response.
    }
  }
  const objects: Record<string, unknown>[] = [];
  for (const candidate of candidates.reverse()) {
    const normalized = candidate.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      const parsed = JSON.parse(normalized);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Try the preceding event/string.
    }
  }
  return objects;
}

function collectJsonStrings(value: unknown, candidates: string[]): void {
  if (typeof value === 'string') {
    candidates.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonStrings(item, candidates));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectJsonStrings(item, candidates));
  }
}

function sanitizeDetail(value: string): string {
  const redacted = redactSecretsInText(value, collectSecretValues(process.env));
  return redacted.slice(0, 2000);
}

function extractExecutionError(stdout: string, stderr: string): string {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: unknown;
        error?: { message?: unknown };
      };
      if (event.type === 'error' && typeof event.message === 'string') {
        messages.push(event.message);
      } else if (
        event.type === 'turn.failed' &&
        typeof event.error?.message === 'string'
      ) {
        messages.push(event.error.message);
      }
    } catch {
      // Ignore non-JSON diagnostic lines and use stderr fallback.
    }
  }
  const fallback = stderr.trim() || (stdout.trim() ? 'OpenCode produced output; inspect correlated task logs' : 'No stdout/stderr received from OpenCode');
  return sanitizeDetail(messages.at(-1) ?? fallback);
}
