import { Injectable } from '@nestjs/common';
import type {
  AgentCodeContext,
  AgentProposal,
  AgentTask,
  LLMProposalResult,
  QualityIssue,
  StructuredPatch,
} from '@amp/core';

const DESCRIPTIONS: Record<string, string> = {
  'typescript:S1128': 'Remove the unused import without changing other imports.',
  'typescript:S1481': 'Remove the unused local variable and preserve surrounding behavior.',
  'typescript:S1186': 'Remove the redundant empty implementation when the language permits it.',
  'typescript:S4325': 'Remove the unnecessary type assertion while preserving the expression.',
  'typescript:S2933': 'Add readonly to the field only after verifying that it is never reassigned.',
};

interface ReadonlyCandidate {
  file: string;
  line: number;
  expectedText: string;
  replacement: string;
  symbol: string;
  forbiddenPatterns: string[];
}

export interface PreconditionResult {
  valid: boolean;
  reason?: string;
}

@Injectable()
export class DeterministicRemediator {
  canHandle(task: AgentTask): boolean {
    return Boolean(task.issue?.rule && DESCRIPTIONS[task.issue.rule]);
  }

  /**
   * Conservative preconditions available from the bounded index context.
   * Full-file reassignment checks are repeated by StructuredPatchEngine at
   * application time, after the proposal has been reviewed.
   */
  validatePreconditions(
    issue: QualityIssue,
    context: AgentCodeContext,
  ): PreconditionResult {
    if (issue.rule !== 'typescript:S2933') return { valid: true };
    const candidate = findReadonlyCandidate(issue, context);
    return candidate
      ? { valid: true }
      : { valid: false, reason: 'No safe TypeScript field declaration was found for S2933.' };
  }

  propose(task: AgentTask, reason: string, _estimatedInputTokens: number): LLMProposalResult {
    const started = Date.now();
    const issue = task.issue;
    const file = issue?.file ?? '';
    const description = DESCRIPTIONS[issue?.rule ?? ''];
    if (!issue || !description) {
      return failure('LOCAL_REMEDIATION_UNAVAILABLE', 'No deterministic remediation is registered.', started);
    }

    const context = task.context as AgentCodeContext;
    const patch = issue.rule === 'typescript:S2933'
      ? createReadonlyPatch(issue, context)
      : undefined;
    if (issue.rule === 'typescript:S2933' && !patch) {
      return failure(
        'LOCAL_PRECONDITION_FAILED',
        'S2933 was not patched because the declaration or line could not be verified safely.',
        started,
      );
    }

    const proposal: AgentProposal = {
      provider: 'local',
      taskId: task.id!,
      summary: description,
      diagnosis: issue.message,
      proposedChanges: [{ file, description }],
      patch,
      affectedFiles: file ? [file] : [],
      agentSuggestedRisk: 'low',
      validationPlan: Object.values(task.validationCommands ?? {}).filter(Boolean) as string[],
      warnings: patch ? ['Reassignment preconditions will be checked again immediately before applying the patch.'] : [],
      remediationStrategy: 'local',
      remediationReason: reason,
      estimatedInputTokens: 0,
    };
    return {
      success: true,
      summary: proposal.summary,
      touchedFiles: file ? [file] : [],
      provider: 'local',
      durationMs: Date.now() - started,
      proposal,
      usage: { estimatedInputTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      executionTrace: {
        indexProvider: context.indexProvider,
        indexState: context.indexState,
        targetSymbol: context.targetSymbol,
        filesIncluded: file ? [file] : [],
        symbolsIncluded: context.symbols?.length ?? 0,
        snippetsIncluded: context.snippets?.length ?? 0,
        snippetChars: (context.snippets ?? []).reduce((sum, item) => sum + item.content.length, 0),
        promptChars: 0,
        promptSha256: '',
        promptPreview: '',
        promptPreviewTruncated: false,
        estimatedInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        strategy: 'local',
        reason,
      },
    };
  }
}

function createReadonlyPatch(
  issue: { file?: string; line?: number; rule?: string },
  context: AgentCodeContext,
): StructuredPatch | undefined {
  const candidate = findReadonlyCandidate(issue, context);
  if (!candidate) return undefined;
  return {
    version: 1,
    edits: [{
      file: candidate.file,
      startLine: candidate.line,
      endLine: candidate.line,
      expectedText: candidate.expectedText,
      replacement: candidate.replacement,
    }],
    preconditions: [{
      file: candidate.file,
      forbiddenPatterns: candidate.forbiddenPatterns,
    }],
  };
}

function findReadonlyCandidate(
  issue: { file?: string; line?: number; rule?: string },
  context: AgentCodeContext,
): ReadonlyCandidate | undefined {
  if (!issue.file || issue.line == null) return undefined;
  const issueFile = normalizeFile(issue.file);
  const matches: ReadonlyCandidate[] = [];
  for (const snippet of context.snippets ?? []) {
    if (normalizeFile(snippet.file) !== issueFile || snippet.startLine == null) continue;
    const lines = snippet.content.split(/\r?\n/);
    for (const [index, text] of lines.entries()) {
      const line = snippet.startLine + index;
      if (line !== issue.line) continue;
      if (/\breadonly\b/.test(text)) continue;
      const match = /^(\s*)((?:(?:public|protected|private)\s+)?(?:static\s+)?)([A-Za-z_$][\w$]*)(\s*\??\s*:\s*[^;{}]+;)(\s*)$/.exec(text);
      if (!match) continue;
      const [, indent, modifiers, symbol, type, trailing] = match;
      const escaped = escapeRegExp(symbol);
      const assignmentPattern = String.raw`(?:(?:^|[^A-Za-z0-9_$.])${escaped}\b|\bthis\s*\.\s*${escaped}\b)\s*(?:\+\+|--|\*\*=|\?\?=|&&=|\|\|=|=(?!=|>))`;
      matches.push({
        file: issueFile,
        line,
        expectedText: text,
        replacement: `${indent}${modifiers}readonly ${symbol}${type}${trailing}`,
        symbol,
        forbiddenPatterns: [assignmentPattern],
      });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function failure(code: string, message: string, started: number): LLMProposalResult {
  return {
    success: false,
    summary: '',
    touchedFiles: [],
    provider: 'local',
    durationMs: Date.now() - started,
    error: { code: code as never, message },
  };
}
