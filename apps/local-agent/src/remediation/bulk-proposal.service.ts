import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mergeProjectProfile, type QualityIssue } from '@amp/core';
import { BulkProposeFixPromptBuilder, type BulkPromptIssue } from '../agent/bulk-propose-fix-prompt.builder';
import { WorkingTreeGuardService, type WorkingTreeSnapshot } from '../agent/working-tree-guard.service';
import { LiteLLMProvider } from '../llm/litellm.provider';
import { AgentProposalRepository } from '../persistence/agent-proposal.repository';
import { ProjectRepository } from '../persistence/project.repository';
import { QualityIssueContextService } from '../quality/quality-issue-context.service';
import { QualityService } from '../quality/quality.service';
import { loadConfig } from '../config/app-config';
import { toAgentContext } from '../pipeline/steps/propose-fix.step';
import { estimateTokens, IssueContextPolicy } from './issue-context-policy.service';

const MAX_SELECTED_ISSUES = 100;
const MAX_ISSUES_PER_GROUP = 3;
const MAX_RECOVERY_SPLIT_DEPTH = 2;
const OUTPUT_BUDGET_SAFETY_RATIO = 0.85;
const COMPLEX_RULES = new Set(['typescript:S3776']);
const CONSTRAINTS = ['preserve existing behavior', 'reuse existing project structure', 'avoid new dependencies'];

interface PreparedIssue extends BulkPromptIssue {
  source: QualityIssue;
}

interface ProposalBaseline {
  mode: 'git' | 'context-files';
  fingerprint: string;
  fileHashes: Record<string, string>;
  files: string[];
  gitSnapshot?: WorkingTreeSnapshot;
}

export interface BulkProposalView {
  selected: number;
  eligible: number;
  proposed: number;
  reused: Array<{ issueId: string; proposalId: string; reason: string }>;
  skipped: Array<{ issueId: string; reason: string }>;
  groups: Array<{
    id: string;
    rule: string;
    file: string;
    issueIds: string[];
    status: 'success' | 'failed';
    prompt: string;
    promptChars: number;
    estimatedInputTokens: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedOutputTokens: number;
    model?: string;
    durationMs: number;
    proposalIds: string[];
    splitFrom?: string;
    retryDepth?: number;
    attempts?: number;
    recoveryPrompt?: string;
    error?: string;
  }>;
}

@Injectable()
export class BulkProposalService {
  constructor(
    private readonly quality: QualityService,
    private readonly contexts: QualityIssueContextService,
    private readonly contextPolicy: IssueContextPolicy,
    private readonly prompts: BulkProposeFixPromptBuilder,
    private readonly llm: LiteLLMProvider,
    private readonly proposals: AgentProposalRepository,
    private readonly projects: ProjectRepository,
    private readonly workingTree: WorkingTreeGuardService,
  ) {}

  async propose(projectId: string, issueIds: string[]): Promise<BulkProposalView> {
    const uniqueIds = [...new Set(issueIds.map((id) => id.trim()).filter(Boolean))];
    if (!uniqueIds.length) throw new BadRequestException('Selecciona al menos un hallazgo');
    if (uniqueIds.length > MAX_SELECTED_ISSUES) throw new BadRequestException(`Solo se permiten ${MAX_SELECTED_ISSUES} hallazgos por ejecución`);
    const project = this.projects.findById(projectId);
    if (!project?.profile) throw new NotFoundException('Proyecto o perfil no encontrado');
    const snapshots = this.quality.listSnapshots(projectId);
    if (!snapshots[0]) throw new BadRequestException('No existe un reporte Sonar guardado');
    const latest = this.quality.getSnapshot(projectId, snapshots[0].id);
    const byId = new Map(latest.issues.map((issue) => [issue.id, issue]));
    const skipped: BulkProposalView['skipped'] = [];
    const reused: BulkProposalView['reused'] = [];
    const eligible: QualityIssue[] = [];
    for (const issueId of uniqueIds) {
      const issue = byId.get(issueId);
      if (!issue) skipped.push({ issueId, reason: 'El hallazgo no pertenece al último reporte Sonar.' });
      else if (isResolved(issue)) skipped.push({ issueId, reason: 'El hallazgo ya está solucionado.' });
      else eligible.push(issue);
    }
    if (!eligible.length) return { selected: uniqueIds.length, eligible: 0, proposed: 0, reused, skipped, groups: [] };

    const latestProposalByIssue = new Map<string, ReturnType<AgentProposalRepository['list']>[number]>();
    for (const proposal of this.proposals.list(projectId)) {
      if (proposal.status !== 'rejected' && !latestProposalByIssue.has(proposal.issueId)) latestProposalByIssue.set(proposal.issueId, proposal);
    }
    const pending = eligible.filter((issue) => {
      const existing = latestProposalByIssue.get(issue.id);
      if (!existing || !proposalFilesUnchanged(project.path, existing.contextFiles, existing.contextFileHashes)) return true;
      reused.push({ issueId: issue.id, proposalId: existing.id, reason: 'Se reutilizó una propuesta vigente porque sus archivos de contexto no cambiaron.' });
      return false;
    });
    if (!pending.length) return { selected: uniqueIds.length, eligible: eligible.length, proposed: 0, reused, skipped, groups: [] };

    const prepared = (await mapConcurrent<QualityIssue, PreparedIssue | null>(pending, 4, async (issue) => {
      const resolved = await this.contexts.resolve(projectId, issue);
      if (!resolved.codeContext) {
        skipped.push({ issueId: issue.id, reason: 'No se pudo resolver contexto desde el índice.' });
        return null;
      }
      const raw = toAgentContext(resolved.codeContext, resolved.warnings, resolved.indexProvider, resolved.indexState, project.path, issue.file);
      const bounded = this.contextPolicy.reduce(raw).context;
      return {
        source: issue,
        issue: { provider: issue.provider, id: issue.id, rule: issue.rule, severity: issue.severity, type: issue.type, message: issue.message, file: issue.file, line: issue.line },
        context: bounded,
      };
    })).filter((item): item is PreparedIssue => item !== null);

    const profile = mergeProjectProfile(project.profile, project.commandOverrides);
    const projectPrompt = { runtime: profile.runtime, framework: profile.framework };
    const groups = this.planGroups(prepared, projectPrompt);
    const health = await this.llm.health();
    if (!health.available) throw new BadRequestException(health.error ?? 'LiteLLM no está disponible');
    const baselineFiles = [...new Set(prepared.flatMap((item) => [item.source.file, ...item.context.files]).map(normalizeFile))];
    const baseline = await this.captureProposalBaseline(project.path, baselineFiles);
    const output: BulkProposalView['groups'] = [];
    let proposed = 0;

    const queue = groups.map((group, index) => ({ group, groupId: `grupo-${index + 1}`, retryDepth: 0, splitFrom: undefined as string | undefined }));
    const processQueue = async (): Promise<void> => {
      while (queue.length) {
      const planned = queue.shift()!;
      const { group, groupId, retryDepth, splitFrom } = planned;
      const input = { project: projectPrompt, items: group, constraints: CONSTRAINTS };
      const result = await this.llm.proposeFixBatch(input);
      const base = {
        id: groupId,
        rule: group[0].source.rule,
        file: summarizeFiles(group.map((item) => item.source.file)),
        issueIds: group.map((item) => item.source.id),
        prompt: result.prompt,
        promptChars: result.prompt.length,
        estimatedInputTokens: result.estimatedInputTokens,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedOutputTokens: group.reduce((sum, item) => sum + estimateIssueOutputTokens(item), 0),
        model: result.model,
        durationMs: result.durationMs,
        splitFrom,
        retryDepth,
        attempts: result.attempts,
        recoveryPrompt: result.recoveryPrompt,
      };
      if (!result.success) {
        const recoverable = result.error?.code === 'LLM_OUTPUT_TRUNCATED' ||
          result.error?.code === 'INVALID_LLM_RESPONSE' ||
          result.error?.code === 'LLM_TIMEOUT';
        const canSplit = recoverable && group.length > 1 && retryDepth < MAX_RECOVERY_SPLIT_DEPTH;
        output.push({
          ...base,
          status: 'failed',
          proposalIds: [],
          error: canSplit
            ? `${result.error?.message ?? 'Respuesta inválida'}. El grupo fue subdividido automáticamente para aislar cada hallazgo; los tokens de este intento ya fueron consumidos.`
            : result.error?.message ?? 'La IA no devolvió una propuesta válida',
        });
        if (canSplit) {
          const middle = Math.ceil(group.length / 2);
          const left = group.slice(0, middle);
          const right = group.slice(middle);
          queue.unshift(
            { group: right, groupId: `${groupId}.2`, retryDepth: retryDepth + 1, splitFrom: groupId },
          );
          queue.unshift(
            { group: left, groupId: `${groupId}.1`, retryDepth: retryDepth + 1, splitFrom: groupId },
          );
        }
        continue;
      }
      if (!(await this.proposalContextUnchanged(project.path, baseline))) {
        output.push({ ...base, status: 'failed', proposalIds: [], error: 'El repositorio cambió durante la generación; no se persistieron propuestas.' });
        break;
      }
      const proposalIds: string[] = [];
      for (const itemResult of result.proposals) {
        const item = group.find((candidate) => candidate.source.id === itemResult.issueId);
        if (!item) continue;
        const files = item.context.files.map(normalizeFile);
        const contextFileHashes = Object.fromEntries(files.filter((file) => baseline.fileHashes?.[file]).map((file) => [file, baseline.fileHashes![file]]));
        const perIssueInput = result.inputTokens == null ? undefined : Math.max(1, Math.ceil(result.inputTokens / result.proposals.length));
        const perIssueOutput = result.outputTokens == null ? undefined : Math.max(1, Math.ceil(result.outputTokens / result.proposals.length));
        const proposal = {
          ...itemResult.proposal,
          validationPlan: [profile.buildCommand, profile.testCommand ?? profile.coverageCommand, profile.e2eCommand, profile.startCommand].filter(Boolean) as string[],
          inputTokens: perIssueInput,
          outputTokens: perIssueOutput,
          warnings: [
            ...(itemResult.proposal.warnings ?? []),
            ...(baseline.mode === 'context-files' ? ['Proyecto sin repositorio Git: la propuesta se protegió con hashes de los archivos de contexto. Para aplicar automáticamente sigue siendo necesario un checkpoint Git.'] : []),
          ],
        };
        const record = this.proposals.create({
          ...proposal,
          projectId,
          issueId: item.source.id,
          providerVersion: result.model,
          durationMs: result.durationMs,
          contextFiles: files,
          contextSizeChars: (item.context.snippets ?? []).reduce((sum, snippet) => sum + snippet.content.length, 0),
          repositoryUnchanged: true,
          contextRevision: baseline.fingerprint,
          contextFileHashes,
          executionTrace: {
            indexProvider: item.context.indexProvider,
            indexState: item.context.indexState,
            targetSymbol: item.context.targetSymbol,
            filesIncluded: files,
            symbolsIncluded: item.context.symbols?.length ?? 0,
            snippetsIncluded: item.context.snippets?.length ?? 0,
            snippetChars: (item.context.snippets ?? []).reduce((sum, snippet) => sum + snippet.content.length, 0),
            promptChars: result.prompt.length,
            promptSha256: createHash('sha256').update(result.prompt).digest('hex'),
            promptPreview: result.prompt,
            promptPreviewTruncated: false,
            estimatedInputTokens: result.estimatedInputTokens,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            strategy: 'llm',
            reason: `Propuesta agrupada ${groupId}; contexto compartido entre ${group.length} hallazgos compatibles.`,
          },
        });
        proposalIds.push(record.id);
        proposed += 1;
      }
      output.push({ ...base, status: proposalIds.length === group.length ? 'success' : 'failed', proposalIds, ...(proposalIds.length === group.length ? {} : { error: 'La respuesta no produjo una propuesta persistible para todos los hallazgos.' }) });
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(loadConfig().llm.batchConcurrency, Math.max(1, groups.length)) },
      () => processQueue(),
    ));
    output.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
    return { selected: uniqueIds.length, eligible: eligible.length, proposed, reused, skipped, groups: output };
  }

  private async captureProposalBaseline(projectPath: string, files: string[]): Promise<ProposalBaseline> {
    try {
      const gitSnapshot = await this.workingTree.capture(projectPath);
      return { mode: 'git', fingerprint: gitSnapshot.fingerprint, fileHashes: gitSnapshot.fileHashes ?? {}, files, gitSnapshot };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'GIT_REPOSITORY_REQUIRED') throw error;
      return captureContextFiles(projectPath, files);
    }
  }

  private async proposalContextUnchanged(projectPath: string, baseline: ProposalBaseline): Promise<boolean> {
    if (baseline.mode === 'git' && baseline.gitSnapshot) {
      const after = await this.workingTree.capture(projectPath);
      return this.workingTree.unchanged(baseline.gitSnapshot, after);
    }
    return captureContextFiles(projectPath, baseline.files).fingerprint === baseline.fingerprint;
  }

  private planGroups(items: PreparedIssue[], project: { runtime?: string; framework?: string }): PreparedIssue[][] {
    const buckets = new Map<string, PreparedIssue[]>();
    for (const item of items) {
      const key = item.source.rule;
      buckets.set(key, [...(buckets.get(key) ?? []), item]);
    }
    const maxTokens = loadConfig().llm.maxInputTokens;
    const groups: PreparedIssue[][] = [];
    const outputBudget = Math.floor(loadConfig().llm.maxOutputTokens * OUTPUT_BUDGET_SAFETY_RATIO);
    for (const unsortedBucket of buckets.values()) {
      const bucket = [...unsortedBucket].sort((a, b) =>
        normalizeFile(a.source.file).localeCompare(normalizeFile(b.source.file)) ||
        (a.source.line ?? 0) - (b.source.line ?? 0),
      );
      let current: PreparedIssue[] = [];
      for (const item of bucket) {
        const candidate = [...current, item];
        const prompt = this.prompts.build({ project, items: candidate, constraints: CONSTRAINTS });
        const estimatedOutput = candidate.reduce((sum, candidateItem) => sum + estimateIssueOutputTokens(candidateItem), 0);
        if (current.length > 0 && (
          candidate.length > MAX_ISSUES_PER_GROUP ||
          estimateTokens(prompt) > maxTokens ||
          estimatedOutput > outputBudget ||
          (candidate.length > 1 && candidate.some(isComplexIssue))
        )) {
          groups.push(current);
          current = [item];
        } else current = candidate;
      }
      if (current.length) groups.push(current);
    }
    return groups;
  }
}

function isComplexIssue(item: PreparedIssue): boolean {
  return COMPLEX_RULES.has(item.source.rule) ||
    item.source.type === 'VULNERABILITY' ||
    (item.context.snippets ?? []).some((snippet) => snippet.content.length > 6_000);
}

function estimateIssueOutputTokens(item: PreparedIssue): number {
  if (COMPLEX_RULES.has(item.source.rule)) return 350;
  if (item.source.type === 'VULNERABILITY') return 480;
  if ((item.context.snippets ?? []).some((snippet) => snippet.content.length > 6_000)) return 500;
  return 480;
}

function isResolved(issue: QualityIssue): boolean {
  return ['CLOSED', 'RESOLVED', 'FIXED', 'REMOVED'].includes(String(issue.status ?? '').toUpperCase());
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function summarizeFiles(files: string[]): string {
  const unique = [...new Set(files.map(normalizeFile))];
  return unique.length === 1 ? unique[0] : `${unique.length} archivos`;
}

function captureContextFiles(projectPath: string, files: string[]): ProposalBaseline {
  const root = path.resolve(projectPath);
  const fileHashes: Record<string, string> = {};
  for (const raw of [...new Set(files.map(normalizeFile))].sort()) {
    if (!raw || path.isAbsolute(raw) || raw.split('/').includes('..')) throw new Error('INVALID_CONTEXT_PATH');
    const absolute = path.resolve(root, raw);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('INVALID_CONTEXT_PATH');
    fileHashes[raw] = fs.existsSync(absolute) && fs.statSync(absolute).isFile()
      ? createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
      : 'missing';
  }
  return {
    mode: 'context-files',
    files: Object.keys(fileHashes),
    fileHashes,
    fingerprint: createHash('sha256').update(JSON.stringify(fileHashes)).digest('hex'),
  };
}

function proposalFilesUnchanged(projectPath: string, files: string[], expectedHashes: Record<string, string>): boolean {
  if (!files.length) return false;
  try {
    const current = captureContextFiles(projectPath, files).fileHashes;
    return files.every((file) => Boolean(expectedHashes[normalizeFile(file)]) && current[normalizeFile(file)] === expectedHashes[normalizeFile(file)]);
  } catch {
    return false;
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, callback: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await callback(items[index]);
    }
  }));
  return results;
}
