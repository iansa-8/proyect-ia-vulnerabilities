import { Injectable } from '@nestjs/common';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
export class CodexAgentProvider implements AgentProvider {
  readonly name = 'codex';
  readonly capabilities = ['apply-fix'] as const;

  constructor(
    private readonly commands: CommandExecutionService,
    private readonly prompts: ProposeFixPromptBuilder,
    private readonly applyPrompts: ApplyFixPromptBuilder,
    private readonly workingTree: WorkingTreeGuardService,
  ) {}

  async health(): Promise<AgentHealth> {
    const config = loadConfig().agent;
    const result = await this.commands.execute({
      command: config.codexCommand,
      args: ['--version'],
      cwd: config.monorepoRoot,
      timeoutMs: Math.min(config.codexTimeoutMs, 30_000),
    });
    const version = /codex-cli\s+([^\s]+)/i.exec(result.stdout)?.[1];
    return {
      available: result.success && Boolean(version),
      provider: this.name,
      version,
      capabilities: [...this.capabilities],
      error: result.success && version ? undefined : 'Codex CLI unavailable',
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
    if (!health.available) return this.failure('AGENT_UNAVAILABLE', health.error ?? 'Codex unavailable');
    const config = loadConfig().agent;
    const schemaPath = path.join(
      config.monorepoRoot, 'apps', 'local-agent', 'src', 'agent', 'agent-apply.schema.json',
    );
    const prompt = this.applyPrompts.build(task);
    const command = await this.commands.execute({
      command: config.codexCommand,
      args: [
        '--ask-for-approval', 'never', 'exec', '--sandbox', 'workspace-write',
        '--ephemeral', '--output-schema', schemaPath, '--json', '--color', 'never',
        '--cd', task.projectPath, '-',
      ],
      cwd: task.projectPath,
      stdin: prompt,
      timeoutMs: config.codexTimeoutMs,
    });
    const durationMs = Date.now() - started;
    if (command.timedOut) return { ...this.failure('AGENT_TIMEOUT', 'Codex execution timed out'), providerVersion: health.version, durationMs };
    if (!command.success) {
      return { ...this.failure('AGENT_EXECUTION_FAILED', extractExecutionError(command.stdout, command.stderr)), providerVersion: health.version, durationMs };
    }
    if (command.stdoutTruncated || command.stderrTruncated || !command.stdout.trim()) {
      return { ...this.failure('INVALID_AGENT_RESPONSE', 'Codex response is empty or truncated'), providerVersion: health.version, durationMs };
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
      };
    } catch {
      return { ...this.failure('INVALID_AGENT_RESPONSE', 'Codex returned an invalid apply result'), providerVersion: health.version, durationMs };
    }
  }

  async proposeFix(task: AgentTask): Promise<AgentResult> {
    const started = Date.now();
    if (task.type !== 'propose-fix' || !task.id || !task.issue || !task.project) {
      return this.failure('INVALID_AGENT_RESPONSE', 'Invalid propose-fix task');
    }
    const health = await this.health();
    if (!health.available) {
      return this.failure('AGENT_UNAVAILABLE', health.error ?? 'Codex unavailable');
    }

    let before;
    try {
      before = await this.workingTree.capture(task.projectPath);
    } catch {
      return this.failure('CONTEXT_UNAVAILABLE', 'Unable to capture repository baseline');
    }

    const config = loadConfig().agent;
    const schemaPath = path.join(
      config.monorepoRoot,
      'apps',
      'local-agent',
      'src',
      'agent',
      'agent-proposal.schema.json',
    );
    const prompt = this.prompts.build(task);
    const executionTrace = buildExecutionTrace(
      task.context as AgentCodeContext,
      prompt,
      config.promptPreviewMaxChars,
    );
    const args = [
      '--ask-for-approval',
      'never',
      'exec',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--output-schema',
      schemaPath,
      '--json',
      '--color',
      'never',
      '--cd',
      task.projectPath,
      '-',
    ];
    const command = await this.commands.execute({
      command: config.codexCommand,
      args,
      cwd: task.projectPath,
      stdin: prompt,
      timeoutMs: config.codexTimeoutMs,
    });

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
        ...this.failure('AGENT_TIMEOUT', 'Codex execution timed out'),
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
        ...this.failure('INVALID_AGENT_RESPONSE', 'Codex response is empty or truncated'),
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
        ...this.failure('INVALID_AGENT_RESPONSE', 'Codex returned an invalid structured proposal'),
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
    promptPreview: prompt.slice(0, previewLimit),
    promptPreviewTruncated: prompt.length > previewLimit,
  };
}

function parseProposal(stdout: string): ProposalWire {
  const candidates: string[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event.item as Record<string, unknown> | undefined;
      if (
        event.type === 'item.completed' &&
        item?.type === 'agent_message' &&
        typeof item.text === 'string'
      ) {
        candidates.push(item.text);
      }
    } catch {
      candidates.push(line);
    }
  }
  const parsed = JSON.parse(candidates.at(-1) ?? stdout) as Partial<ProposalWire>;
  if (
    typeof parsed.summary !== 'string' ||
    !Array.isArray(parsed.proposedChanges) ||
    !Array.isArray(parsed.affectedFiles) ||
    !['low', 'medium', 'high', 'unknown'].includes(String(parsed.risk)) ||
    !Array.isArray(parsed.validationPlan)
  ) {
    throw new Error('invalid proposal');
  }
  for (const change of parsed.proposedChanges) {
    if (
      !change ||
      typeof change.file !== 'string' ||
      typeof change.description !== 'string'
    ) {
      throw new Error('invalid proposed change');
    }
  }
  return parsed as ProposalWire;
}

function parseApplyResult(stdout: string): { summary: string; warnings: string[] } {
  const candidates: string[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event.item as Record<string, unknown> | undefined;
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') candidates.push(item.text);
    } catch { candidates.push(line); }
  }
  const value = JSON.parse(candidates.at(-1) ?? stdout) as { summary?: unknown; warnings?: unknown };
  if (typeof value.summary !== 'string' || !Array.isArray(value.warnings) || value.warnings.some((item) => typeof item !== 'string')) throw new Error('invalid apply result');
  return { summary: value.summary, warnings: value.warnings as string[] };
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
  const fallback = stderr.trim() || 'Codex execution failed';
  return sanitizeDetail(messages.at(-1) ?? fallback);
}
