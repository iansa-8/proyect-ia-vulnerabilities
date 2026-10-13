import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  collectSecretValues,
  redactSecretsInText,
  type AgentCodeContext,
  type AgentProposal,
  type LLMHealth,
  type LLMProposalResult,
  type LLMProposalTask,
  type StructuredPatch,
} from '@amp/core';
import type { LLMProvider } from '@amp/providers';
import { loadConfig } from '../config/app-config';
import { ProposeFixPromptBuilder } from '../agent/propose-fix-prompt.builder';
import { BulkProposeFixPromptBuilder, type BulkPromptInput } from '../agent/bulk-propose-fix-prompt.builder';
import { estimateTokens } from '../remediation/issue-context-policy.service';

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface ProposalWire {
  summary: string;
  proposedChanges: Array<{ file: string; description: string; rationale?: string }>;
  risk: AgentProposal['agentSuggestedRisk'];
  confidence?: number;
  warnings?: string[];
  patch?: StructuredPatch;
  requiresAgent?: boolean;
  escalationReason?: string;
}

export interface BulkProposalResult {
  success: boolean;
  prompt: string;
  model?: string;
  durationMs: number;
  estimatedInputTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  attempts?: number;
  recoveryPrompt?: string;
  proposals: Array<{ issueId: string; proposal: AgentProposal }>;
  error?: { code: string; message: string };
}

@Injectable()
export class LiteLLMProvider implements LLMProvider {
  readonly name = 'litellm';

  constructor(
    private readonly prompts: ProposeFixPromptBuilder,
    private readonly bulkPrompts: BulkProposeFixPromptBuilder = new BulkProposeFixPromptBuilder(),
  ) {}

  async health(): Promise<LLMHealth> {
    const config = loadConfig().llm;
    if (!config.baseUrl || !config.model || !config.apiKey) {
      return { available: false, provider: this.name, model: config.model || undefined, error: 'LiteLLM configuration is incomplete' };
    }
    try {
      const response = await fetch(endpoint(config.baseUrl, 'models'), {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(Math.min(config.timeoutMs, 5_000)),
      });
      return { available: response.ok, provider: this.name, model: config.model, error: response.ok ? undefined : `LiteLLM health returned HTTP ${response.status}` };
    } catch {
      return { available: false, provider: this.name, model: config.model, error: 'LiteLLM gateway unavailable' };
    }
  }

  async proposeFix(task: LLMProposalTask): Promise<LLMProposalResult> {
    const started = Date.now();
    const config = loadConfig().llm;
    const prompt = this.prompts.build(task);
    const estimatedInputTokens = estimateTokens(prompt);
    if (!config.apiKey || !config.model) return failure('LLM_UNAVAILABLE', 'LiteLLM configuration is incomplete', started);
    if (estimatedInputTokens > config.maxInputTokens) return failure('LLM_INPUT_TOO_LARGE', 'Prompt exceeds configured input token budget', started);
    const secrets = collectSecretValues(process.env, [config.apiKey]);
    try {
      const response = await fetch(endpoint(config.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: config.maxOutputTokens,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        const detail = redactSecretsInText((await response.text()).slice(0, 1_000), secrets);
        return failure('LLM_EXECUTION_FAILED', `LiteLLM HTTP ${response.status}: ${detail}`, started);
      }
      const body = await response.json() as ChatCompletionResponse;
      if (body.choices?.[0]?.finish_reason === 'length') {
        return failure('LLM_OUTPUT_TRUNCATED', 'LiteLLM response reached the configured output limit', started);
      }
      const content = body.choices?.[0]?.message?.content?.trim();
      if (!content) return failure('INVALID_LLM_RESPONSE', 'LiteLLM returned an empty response', started);
      let wire: ProposalWire;
      try {
        wire = parseProposal(content, task.issue?.file);
      } catch (error) {
        const reason = error instanceof ProposalValidationError
          ? error.reason
          : 'invalid_json';
        return failure('INVALID_LLM_RESPONSE', `LiteLLM returned an invalid proposal (${reason})`, started);
      }
      const context = task.context as AgentCodeContext;
      const proposal: AgentProposal = {
        provider: this.name,
        taskId: task.id!,
        summary: wire.summary,
        proposedChanges: wire.proposedChanges,
        patch: wire.patch,
        affectedFiles: [...new Set([
           ...wire.proposedChanges.map((item) => item.file),
           ...(wire.patch?.edits.map((edit) => edit.file) ?? []),
         ])],
        agentSuggestedRisk: wire.risk,
        validationPlan: Object.values(task.validationCommands ?? {}).filter(Boolean) as string[],
        warnings: wire.warnings ?? [],
        remediationStrategy: 'llm',
        remediationReason: 'Propuesta razonada por el LLM configurado.',
        estimatedInputTokens,
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
        requiresAgent: wire.requiresAgent ?? false,
        escalationReason: wire.escalationReason,
      };
      const previewLimit = config.promptPreviewMaxChars;
      return {
        success: true,
        summary: proposal.summary,
        touchedFiles: [],
        provider: this.name,
        providerVersion: body.model ?? config.model,
        model: body.model ?? config.model,
        durationMs: Date.now() - started,
        proposal,
        usage: { estimatedInputTokens, inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens, totalTokens: body.usage?.total_tokens },
        executionTrace: {
          indexProvider: context.indexProvider,
          indexState: context.indexState,
          targetSymbol: context.targetSymbol,
          filesIncluded: context.files,
          symbolsIncluded: context.symbols?.length ?? 0,
          snippetsIncluded: context.snippets?.length ?? 0,
          snippetChars: (context.snippets ?? []).reduce((sum, item) => sum + item.content.length, 0),
          promptChars: prompt.length,
          promptSha256: createHash('sha256').update(prompt).digest('hex'),
          promptPreview: prompt.slice(0, previewLimit),
          promptPreviewTruncated: prompt.length > previewLimit,
          estimatedInputTokens,
          inputTokens: body.usage?.prompt_tokens,
          outputTokens: body.usage?.completion_tokens,
          strategy: 'llm',
          reason: proposal.remediationReason,
        },
      };
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError' ? 'LiteLLM request timed out' : 'LiteLLM request failed';
      return failure('LLM_EXECUTION_FAILED', message, started);
    }
  }

  async proposeFixBatch(input: BulkPromptInput): Promise<BulkProposalResult> {
    const started = Date.now();
    const config = loadConfig().llm;
    const prompt = this.bulkPrompts.build(input);
    const estimatedInputTokens = estimateTokens(prompt);
    let aggregateUsage: ChatCompletionResponse['usage'] | undefined;
    let responseModel: string | undefined;
    let attempts = 0;
    let recoveryPrompt: string | undefined;
    const empty = (code: string, message: string): BulkProposalResult => ({
      success: false,
      prompt,
      model: responseModel,
      durationMs: Date.now() - started,
      estimatedInputTokens,
      inputTokens: aggregateUsage?.prompt_tokens,
      outputTokens: aggregateUsage?.completion_tokens,
      attempts,
      recoveryPrompt,
      proposals: [],
      error: { code, message },
    });
    if (!config.apiKey || !config.model) return empty('LLM_UNAVAILABLE', 'LiteLLM configuration is incomplete');
    if (estimatedInputTokens > config.maxInputTokens) return empty('LLM_INPUT_TOO_LARGE', 'Batch prompt exceeds configured input token budget');
    const secrets = collectSecretValues(process.env, [config.apiKey]);
    try {
      const request = async (requestPrompt: string, maxTokens: number): Promise<ChatCompletionResponse> => {
        attempts += 1;
        const response = await fetch(endpoint(config.baseUrl, 'chat/completions'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: requestPrompt }],
            max_tokens: maxTokens,
            temperature: 0,
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (!response.ok) {
          const detail = redactSecretsInText((await response.text()).slice(0, 1_000), secrets);
          throw new BatchRequestError('LLM_EXECUTION_FAILED', `LiteLLM HTTP ${response.status}: ${detail}`);
        }
        const body = await response.json() as ChatCompletionResponse;
        aggregateUsage = mergeUsage(aggregateUsage, body.usage);
        responseModel = body.model ?? responseModel ?? config.model;
        return body;
      };

      let body = await request(prompt, config.maxOutputTokens);
      if (body.choices?.[0]?.finish_reason === 'length') {
        return empty('LLM_OUTPUT_TRUNCATED', 'LiteLLM alcanzó el límite configurado de salida');
      }
      let content = body.choices?.[0]?.message?.content?.trim();
      if (!content) return empty('INVALID_LLM_RESPONSE', 'LiteLLM devolvió una respuesta batch vacía');
      const requested = new Map(input.items.map((item) => [item.issue.id, item.issue]));
      let wires: Array<{ issueId: string; wire: ProposalWire }>;
      try {
        wires = parseBatchProposals(content, requested);
      } catch (error) {
        if (!(error instanceof ProposalValidationError) && !(error instanceof SyntaxError)) throw error;
        recoveryPrompt = buildBatchRecoveryPrompt(content, [...requested.keys()]);
        body = await request(recoveryPrompt, Math.min(config.maxOutputTokens, 900));
        if (body.choices?.[0]?.finish_reason === 'length') {
          return empty('LLM_OUTPUT_TRUNCATED', 'La reparación JSON de LiteLLM alcanzó el límite configurado de salida');
        }
        content = body.choices?.[0]?.message?.content?.trim();
        if (!content) return empty('INVALID_LLM_RESPONSE', 'LiteLLM devolvió una reparación batch vacía');
        wires = parseBatchProposals(content, requested);
      }
      const share = Math.max(1, Math.ceil(estimatedInputTokens / wires.length));
      return {
        success: true,
        prompt,
        model: responseModel ?? config.model,
        durationMs: Date.now() - started,
        estimatedInputTokens,
        inputTokens: aggregateUsage?.prompt_tokens,
        outputTokens: aggregateUsage?.completion_tokens,
        attempts,
        recoveryPrompt,
        proposals: wires.map(({ issueId, wire }) => ({
          issueId,
          proposal: {
            provider: this.name,
            taskId: randomUUID(),
            summary: wire.summary,
            proposedChanges: wire.proposedChanges,
            patch: wire.patch,
            affectedFiles: [...new Set([...wire.proposedChanges.map((item) => item.file), ...(wire.patch?.edits.map((edit) => edit.file) ?? [])])],
            agentSuggestedRisk: wire.risk,
            validationPlan: [],
            warnings: wire.warnings ?? [],
            remediationStrategy: 'llm',
            remediationReason: 'Propuesta agrupada y razonada por el LLM configurado.',
            estimatedInputTokens: share,
            requiresAgent: wire.requiresAgent ?? false,
            escalationReason: wire.escalationReason,
          },
        })),
      };
    } catch (error) {
      if (error instanceof BatchRequestError) return empty(error.code, error.message);
      if (error instanceof ProposalValidationError) return empty('INVALID_LLM_RESPONSE', `LiteLLM devolvió una propuesta batch inválida (${error.reason})`);
      if (error instanceof SyntaxError) return empty('INVALID_LLM_RESPONSE', 'LiteLLM devolvió JSON inválido para el batch');
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return empty('LLM_TIMEOUT', 'La solicitud batch a LiteLLM agotó el tiempo de espera');
      }
      return empty('LLM_EXECUTION_FAILED', `La solicitud batch a LiteLLM falló: ${transportErrorDetail(error, secrets)}`);
    }
  }
}

function buildBatchRecoveryPrompt(invalidResponse: string, issueIds: string[]): string {
  const bounded = invalidResponse.slice(0, 8_000);
  return [
    'Repair the following model response into valid compact JSON. Do not add facts or explanations.',
    `Return exactly these issue IDs: ${JSON.stringify(issueIds)}.`,
    'Schema: {"proposals":[{"issueId":"...","summary":"...","proposedChanges":[{"file":"...","description":"..."}],"risk":"low|medium|high|unknown","warnings":[],"requiresAgent":true,"escalationReason":"..."}]}',
    'Omit patch if it is malformed, incomplete, multiline, or longer than 500 characters. Return JSON only.',
    bounded,
  ].join('\n');
}

function mergeUsage(current: ChatCompletionResponse['usage'], next: ChatCompletionResponse['usage']): ChatCompletionResponse['usage'] {
  if (!current && !next) return undefined;
  return {
    prompt_tokens: (current?.prompt_tokens ?? 0) + (next?.prompt_tokens ?? 0),
    completion_tokens: (current?.completion_tokens ?? 0) + (next?.completion_tokens ?? 0),
    total_tokens: (current?.total_tokens ?? 0) + (next?.total_tokens ?? 0),
  };
}

class BatchRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function parseBatchProposals(content: string, requested: Map<string, { file?: string }>): Array<{ issueId: string; wire: ProposalWire }> {
  const parsed = parseJsonContent(content);
  const root = isRecord(parsed) && isRecord(parsed.result) ? parsed.result : parsed;
  let entries: unknown[];
  if (isRecord(root)) {
    const candidate = root.proposals ?? root.fixes ?? root.results ?? root.recommendations;
    if (Array.isArray(candidate)) entries = candidate;
    else if (isRecord(candidate)) entries = Object.entries(candidate).map(([issueId, value]) => isRecord(value) ? { issueId, ...value } : value);
    else if (requested.size === 1) entries = [isRecord(root.proposal) ? root.proposal : root];
    else throw new ProposalValidationError('schema:proposals');
  } else if (Array.isArray(root)) entries = root;
  else throw new ProposalValidationError('schema:proposals');
  if (entries.length !== requested.size) throw new ProposalValidationError('schema:proposal_count');
  const seen = new Set<string>();
  const onlyRequestedId = requested.size === 1 ? [...requested.keys()][0] : undefined;
  const result = entries.map((entry) => {
    if (!isRecord(entry)) throw new ProposalValidationError('schema:proposal');
    const issueId = optionalString(entry.issueId ?? entry.issue_id ?? entry.sonarIssueId ?? entry.id) ?? onlyRequestedId;
    if (!issueId || !requested.has(issueId) || seen.has(issueId)) throw new ProposalValidationError('schema:issueId');
    seen.add(issueId);
    return { issueId, wire: parseProposal(JSON.stringify(entry), requested.get(issueId)?.file) };
  });
  if ([...requested.keys()].some((id) => !seen.has(id))) throw new ProposalValidationError('schema:missing_issue');
  return result;
}

function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
  return `${base}/v1/${path}`;
}

function parseProposal(content: string, fallbackFile?: string): ProposalWire {
  const parsed = parseJsonContent(content);
  const envelope = isRecord(parsed) && isRecord(parsed.proposal) ? parsed.proposal : parsed;
  if (!isRecord(envelope)) throw new ProposalValidationError('schema:root');
  const normalizedChanges = normalizeProposedChanges(
    envelope.proposedChanges ?? envelope.proposed_changes ?? envelope.changes,
    fallbackFile,
  );
  const summary = optionalString(envelope.summary ?? envelope.title);
  const changes = normalizedChanges.length > 0
    ? normalizedChanges
    : summary && fallbackFile
      ? [{ file: fallbackFile, description: summary }]
      : [];
  const rawRisk = String(envelope.risk ?? envelope.riskLevel ?? envelope.risk_level ?? envelope.agentSuggestedRisk ?? 'unknown').toLowerCase();
  const confidence = optionalNumber(envelope.confidence);
  const warnings = normalizeWarnings(envelope.warnings);
  const requiresAgent = optionalBoolean(envelope.requiresAgent ?? envelope.requires_agent);
  const escalationReason = optionalString(envelope.escalationReason ?? envelope.escalation_reason);
  const rawPatch = envelope.patch == null ? undefined : envelope.patch;
  const patch = normalizeStructuredPatch(rawPatch);
  const invalidPatch = rawPatch !== undefined && patch === undefined;
  const normalizedWarnings = [...(warnings ?? [])];
  if (invalidPatch) normalizedWarnings.push('El LLM devolvió un patch no aplicable; se conservó la propuesta y se descartó únicamente el patch inseguro.');
  const value: Partial<ProposalWire> = {
    summary: summary ?? changes[0]?.description ?? 'Propuesta de corrección',
    proposedChanges: changes,
    risk: rawRisk as AgentProposal['agentSuggestedRisk'],
    confidence,
    warnings: normalizedWarnings,
    patch,
    requiresAgent: invalidPatch ? true : requiresAgent,
    escalationReason: invalidPatch
      ? escalationReason ?? 'El patch estructurado no superó la validación; la aplicación debe delegarse al agente.'
      : escalationReason,
  };
  if (typeof value.summary !== 'string' || !value.summary.trim()) {
    throw new ProposalValidationError('schema:summary');
  }
  if (
    !Array.isArray(value.proposedChanges) ||
    value.proposedChanges.length === 0 ||
    value.proposedChanges.length > 50 ||
    value.proposedChanges.some((change) =>
      typeof change?.file !== 'string' ||
      typeof change.description !== 'string' ||
      !isSafeRelativeFile(change.file),
    )
  ) throw new ProposalValidationError('schema:proposedChanges');
  if (!['low', 'medium', 'high', 'unknown'].includes(String(value.risk))) {
    throw new ProposalValidationError('schema:risk');
  }
  if (value.confidence !== undefined && (value.confidence < 0 || value.confidence > 1)) {
    throw new ProposalValidationError('schema:confidence');
  }
  if (value.requiresAgent !== undefined && typeof value.requiresAgent !== 'boolean') {
    throw new ProposalValidationError('schema:requiresAgent');
  }
  if (value.escalationReason !== undefined && typeof value.escalationReason !== 'string') {
    throw new ProposalValidationError('schema:escalationReason');
  }
  return value as ProposalWire;
}

function parseJsonContent(content: string): unknown {
  const extracted = extractJsonValue(content);
  try {
    return JSON.parse(extracted) as unknown;
  } catch (originalError) {
    const repaired = repairCommonJsonMistakes(extracted);
    if (repaired === extracted) throw originalError;
    return JSON.parse(repaired) as unknown;
  }
}

function extractJsonValue(content: string): string {
  const trimmed = content.trim().replace(/^\uFEFF/, '');
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  if (fenced) return extractJsonValue(fenced);
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  if (start >= 0) {
    const opening = trimmed[start];
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === opening) depth += 1;
      else if (char === closing && --depth === 0) return trimmed.slice(start, index + 1);
    }
  }
  throw new ProposalValidationError('json_value_not_found');
}

function repairCommonJsonMistakes(value: string): string {
  let inString = false;
  let escaped = false;
  let repaired = '';
  for (const char of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
        repaired += char;
      } else if (char === '\\') {
        escaped = true;
        repaired += char;
      } else if (char === '"') {
        inString = false;
        repaired += char;
      } else if (char === '\n') repaired += '\\n';
      else if (char === '\r') repaired += '\\r';
      else if (char === '\t') repaired += '\\t';
      else repaired += char;
    } else {
      if (char === '"') inString = true;
      repaired += char;
    }
  }
  return repaired.replace(/,\s*([}\]])/g, '$1');
}

function normalizeProposedChanges(value: unknown, fallbackFile?: string): ProposalWire['proposedChanges'] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.entries(value).map(([file, description]) => ({ file, description }))
      : [];
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') {
      return fallbackFile ? [{ file: fallbackFile, description: entry }] : [];
    }
    if (!isRecord(entry)) return [];
    const file = optionalString(entry.file ?? entry.path ?? entry.filePath) ?? fallbackFile;
    const description = optionalString(entry.description ?? entry.change ?? entry.summary);
    const rationale = optionalString(entry.rationale ?? entry.reason);
    return file && description ? [{ file, description, ...(rationale ? { rationale } : {}) }] : [];
  });
}

function normalizeWarnings(value: unknown): string[] | undefined {
  if (value == null) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStructuredPatch(value: unknown): value is StructuredPatch {
  if (!value || typeof value !== 'object') return false;
  const patch = value as Partial<StructuredPatch>;
  if (patch.version !== 1 || !Array.isArray(patch.edits) || patch.edits.length === 0 || patch.edits.length > 50 || !Array.isArray(patch.preconditions)) return false;
  if (!patch.edits.every((edit) =>
    edit &&
    typeof edit.file === 'string' && isSafeRelativeFile(edit.file) &&
    Number.isSafeInteger(edit.startLine) && Number.isSafeInteger(edit.endLine) &&
    edit.startLine >= 1 && edit.endLine >= edit.startLine &&
    typeof edit.expectedText === 'string' && typeof edit.replacement === 'string',
  )) return false;
  return patch.preconditions.every((precondition) =>
    precondition &&
    typeof precondition.file === 'string' && isSafeRelativeFile(precondition.file) &&
    Array.isArray(precondition.forbiddenPatterns) &&
    precondition.forbiddenPatterns.length <= 20 &&
    precondition.forbiddenPatterns.every((pattern) => typeof pattern === 'string' && pattern.length <= 500),
  );
}

function normalizeStructuredPatch(value: unknown): StructuredPatch | undefined {
  if (value == null || !isRecord(value)) return undefined;
  const rawEdits = value.edits ?? value.changes;
  if (!Array.isArray(rawEdits)) return undefined;
  const edits = rawEdits.map((edit) => {
    if (!isRecord(edit)) return undefined;
    const file = optionalString(edit.file ?? edit.path ?? edit.filePath);
    const startLine = optionalInteger(edit.startLine ?? edit.start_line ?? edit.line);
    const endLine = optionalInteger(edit.endLine ?? edit.end_line ?? edit.line ?? startLine);
    const expectedText = typeof (edit.expectedText ?? edit.expected_text ?? edit.original) === 'string'
      ? String(edit.expectedText ?? edit.expected_text ?? edit.original)
      : undefined;
    const replacement = typeof (edit.replacement ?? edit.newText ?? edit.new_text) === 'string'
      ? String(edit.replacement ?? edit.newText ?? edit.new_text)
      : undefined;
    if (!file || startLine === undefined || endLine === undefined || expectedText === undefined || replacement === undefined) return undefined;
    return { file, startLine, endLine, expectedText, replacement };
  });
  if (edits.some((edit) => edit === undefined)) return undefined;
  const rawPreconditions = value.preconditions == null ? [] : value.preconditions;
  if (!Array.isArray(rawPreconditions)) return undefined;
  const preconditions = rawPreconditions.map((precondition) => {
    if (!isRecord(precondition)) return undefined;
    const file = optionalString(precondition.file ?? precondition.path);
    const forbiddenPatterns = precondition.forbiddenPatterns ?? precondition.forbidden_patterns ?? [];
    if (!file || !Array.isArray(forbiddenPatterns) || forbiddenPatterns.some((pattern) => typeof pattern !== 'string')) return undefined;
    return { file, forbiddenPatterns: forbiddenPatterns as string[] };
  });
  if (preconditions.some((precondition) => precondition === undefined)) return undefined;
  const patch = { version: 1 as const, edits: edits as StructuredPatch['edits'], preconditions: preconditions as StructuredPatch['preconditions'] };
  return isStructuredPatch(patch) ? patch : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function transportErrorDetail(error: unknown, secrets: string[]): string {
  const source = error instanceof Error ? error : undefined;
  const cause = source?.cause;
  const causeCode = isRecord(cause) ? optionalString(cause.code) : undefined;
  const detail = [source?.message, causeCode].filter(Boolean).join(' · ') || 'error de transporte desconocido';
  return redactSecretsInText(detail.slice(0, 500), secrets);
}

class ProposalValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function isSafeRelativeFile(file: string): boolean {
  const normalized = file.trim().replace(/\\/g, '/');
  return Boolean(normalized) &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split('/').includes('..') &&
    !normalized.includes('\0');
}

function failure(code: string, message: string, started: number): LLMProposalResult {
  return { success: false, summary: '', touchedFiles: [], durationMs: Date.now() - started, error: { code: code as never, message } };
}
