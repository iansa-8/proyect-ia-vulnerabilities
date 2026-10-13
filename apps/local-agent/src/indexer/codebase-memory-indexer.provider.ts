import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { CommandResult } from '@amp/core';
import type {
  CodeRelation,
  CodeSnippet,
  CodeSymbol,
  IndexContextQuery,
  IndexContextResult,
  IndexerHealth,
  IndexerProvider,
  IndexProjectInput,
  IndexProjectResult,
  ProjectIndexStatus,
} from '@amp/providers';
import { loadConfig } from '../config/app-config';
import { CommandExecutionService } from '../execution/command-execution.service';
import {
  assertExistingProjectDirectory,
  validateProjectPath,
} from '../common/path-validation';
import {
  ProjectIndexRepository,
  type ProjectIndexMetadata,
} from '../persistence/project-index.repository';
import { ProjectRepository } from '../persistence/project.repository';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  CliOutputParseError,
  extractJsonPayload,
} from './cli-json';

interface GitSnapshot {
  commit?: string;
  porcelain: string;
  fingerprint: string;
  dirty: boolean;
}

interface ListedProject {
  name: string;
  rootPath?: string;
  nodeCount?: number;
  edgeCount?: number;
}

/**
 * Real IndexerProvider backed by Codebase Memory CLI (via CommandExecutionService).
 * Does NOT copy the knowledge graph into SQLite — only index metadata.
 */
@Injectable()
export class CodebaseMemoryIndexerProvider implements IndexerProvider {
  readonly name = 'codebase-memory';
  private readonly logger = new Logger(CodebaseMemoryIndexerProvider.name);

  constructor(
    private readonly commands: CommandExecutionService,
    private readonly indexes: ProjectIndexRepository,
    private readonly projects: ProjectRepository,
  ) {}

  async health(): Promise<IndexerHealth> {
    const config = loadConfig();
    const version = await this.tryVersion();
    const cli = await this.runCli(
      ['cli', '--json', '--quiet', 'list_projects', '--format', 'json', '--limit', '1'],
      config.monorepoRoot,
      config.indexer.indexQueryTimeoutMs,
    );
    const uiAvailable = await this.probeUi(
      config.indexer.codebaseMemoryUiUrl,
      config.indexer.uiProbeTimeoutMs,
    );

    if (!cli.success) {
      return {
        provider: this.name,
        cliAvailable: false,
        uiAvailable,
        version,
        error: summarizeCliFailure(cli),
      };
    }

    try {
      extractJsonPayload(cli.stdout);
      return {
        provider: this.name,
        cliAvailable: true,
        uiAvailable,
        version,
      };
    } catch (err: unknown) {
      return {
        provider: this.name,
        cliAvailable: false,
        uiAvailable,
        version,
        error:
          err instanceof Error
            ? err.message
            : 'Salida inválida de list_projects',
      };
    }
  }

  async indexProject(input: IndexProjectInput): Promise<IndexProjectResult> {
    const config = loadConfig();
    const started = Date.now();
    const indexedAt = new Date().toISOString();

    let safePath: string;
    try {
      safePath = validateProjectPath(input.projectPath);
      assertExistingProjectDirectory(safePath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.indexes.upsert({
        projectId: input.projectId,
        provider: this.name,
        status: 'failed',
        indexedAt,
        durationMs: Date.now() - started,
        error: message,
      });
      return {
        success: false,
        provider: this.name,
        indexedAt,
        durationMs: Date.now() - started,
        error: message,
      };
    }

    const currentStatus = await this.getProjectIndexStatus(input.projectId);
    if (currentStatus.state === 'ready' && !input.forceReindex) {
      return {
        success: true,
        provider: this.name,
        providerProjectName: currentStatus.providerProjectName,
        indexedAt: currentStatus.indexedAt ?? indexedAt,
        durationMs: Date.now() - started,
        gitCommit: currentStatus.indexedRevision,
        skipped: true,
        stats: {
          files: currentStatus.filesCount,
          symbols: currentStatus.symbolsCount,
          relationships: currentStatus.relationshipsCount,
        },
      };
    }

    this.indexes.upsert({
      projectId: input.projectId,
      provider: this.name,
      providerProjectName: currentStatus.providerProjectName ?? null,
      status: 'indexing',
      indexedAt: currentStatus.indexedAt ?? null,
      durationMs: null,
      gitCommit: currentStatus.indexedRevision ?? null,
      filesCount: currentStatus.filesCount ?? null,
      symbolsCount: currentStatus.symbolsCount ?? null,
      relationshipsCount: currentStatus.relationshipsCount ?? null,
      error: null,
      metadata: null,
    });

    const git = await this.captureGitSnapshot(safePath);

    const indexArgs = [
      'cli',
      '--json',
      '--quiet',
      'index_repository',
      '--repo-path',
      safePath,
      '--mode',
      'fast',
    ];

    const indexResult = await this.runCli(
      indexArgs,
      safePath,
      config.indexer.indexCommandTimeoutMs,
    );

    if (!indexResult.success) {
      const error = summarizeCliFailure(indexResult);
      this.indexes.upsert({
        projectId: input.projectId,
        provider: this.name,
        status: 'failed',
        indexedAt,
        durationMs: Date.now() - started,
        gitCommit: git.commit ?? null,
        error,
        metadata: toMetadata(git),
      });
      return {
        success: false,
        provider: this.name,
        indexedAt,
        durationMs: Date.now() - started,
        gitCommit: git.commit,
        error,
      };
    }

    let providerProjectName: string | undefined;
    let stats: IndexProjectResult['stats'];
    try {
      const listed = await this.listProjects(safePath);
      const match = matchListedProject(listed, safePath);
      providerProjectName = match?.name;
      if (match) {
        stats = {
          symbols: match.nodeCount,
          relationships: match.edgeCount,
        };
      }
    } catch (err: unknown) {
      this.logger.warn(
        `list_projects after index failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!providerProjectName) {
      // Fall back to structured index output if present
      try {
        const payload = asRecord(extractJsonPayload(indexResult.stdout));
        providerProjectName =
          asString(payload?.project) ??
          asString(payload?.name) ??
          asString(payload?.project_name);
      } catch {
        // ignore
      }
    }

    const durationMs = Date.now() - started;
    this.indexes.upsert({
      projectId: input.projectId,
      provider: this.name,
      providerProjectName: providerProjectName ?? null,
      status: 'ready',
      indexedAt,
      durationMs,
      gitCommit: git.commit ?? null,
      filesCount: stats?.files ?? null,
      symbolsCount: stats?.symbols ?? null,
      relationshipsCount: stats?.relationships ?? null,
      error: null,
      metadata: toMetadata(git),
    });

    return {
      success: true,
      provider: this.name,
      providerProjectName,
      indexedAt,
      durationMs,
      gitCommit: git.commit,
      stats,
    };
  }

  async getProjectIndexStatus(projectId: string): Promise<ProjectIndexStatus> {
    const record = this.indexes.findByProjectId(projectId);
    if (!record) {
      return {
        projectId,
        provider: this.name,
        state: 'not_indexed',
      };
    }

    if (record.status === 'indexing') {
      return {
        projectId,
        provider: record.provider,
        state: 'indexing',
        providerProjectName: record.providerProjectName ?? undefined,
        indexedAt: record.indexedAt ?? undefined,
        indexedRevision: record.gitCommit ?? undefined,
        error: record.error ?? undefined,
      };
    }

    if (record.status === 'failed') {
      return {
        projectId,
        provider: record.provider,
        state: 'failed',
        providerProjectName: record.providerProjectName ?? undefined,
        indexedAt: record.indexedAt ?? undefined,
        durationMs: record.durationMs ?? undefined,
        indexedRevision: record.gitCommit ?? undefined,
        filesCount: record.filesCount ?? undefined,
        symbolsCount: record.symbolsCount ?? undefined,
        relationshipsCount: record.relationshipsCount ?? undefined,
        error: record.error ?? undefined,
      };
    }

    // ready / stale — compare git HEAD + working tree fingerprint
    const projectPath = await this.resolveProjectPath(projectId);
    let currentRevision: string | undefined;
    let workingTreeClean: boolean | undefined;
    let state = record.status;

    if (projectPath) {
      const git = await this.captureGitSnapshot(projectPath);
      currentRevision = git.commit;
      workingTreeClean = !git.dirty;
      const meta = record.metadata;
      const headChanged =
        Boolean(record.gitCommit) &&
        Boolean(git.commit) &&
        record.gitCommit !== git.commit;
      const fingerprintChanged =
        Boolean(meta?.workingTreeFingerprint) &&
        meta?.workingTreeFingerprint !== git.fingerprint;
      if (record.status === 'ready' && (headChanged || fingerprintChanged)) {
        state = 'stale';
      }
    }

    return {
      projectId,
      provider: record.provider,
      state,
      providerProjectName: record.providerProjectName ?? undefined,
      indexedAt: record.indexedAt ?? undefined,
      durationMs: record.durationMs ?? undefined,
      indexedRevision: record.gitCommit ?? undefined,
      currentRevision,
      workingTreeClean,
      filesCount: record.filesCount ?? undefined,
      symbolsCount: record.symbolsCount ?? undefined,
      relationshipsCount: record.relationshipsCount ?? undefined,
      error: record.error ?? undefined,
    };
  }

  async getContext(query: IndexContextQuery): Promise<IndexContextResult> {
    const empty: IndexContextResult = {
      query,
      symbols: [],
      relatedFiles: [],
      relations: [],
      tests: [],
      snippets: [],
    };

    if (!query.symbol?.trim() && !query.file?.trim()) {
      return empty;
    }

    const config = loadConfig();
    let safePath: string;
    try {
      safePath = validateProjectPath(query.projectPath);
      assertExistingProjectDirectory(safePath);
    } catch {
      return empty;
    }

    const status = await this.getProjectIndexStatus(query.projectId);
    const projectName =
      query.providerProjectName ?? status.providerProjectName;
    if (!projectName) {
      return empty;
    }

    const symbolName = query.symbol?.trim() ?? '';
    const pattern = escapeRegexLiteral(symbolName);

    let searchPayload: unknown;
    try {
      const searchArgs = [
        'cli',
        '--json',
        '--quiet',
        'search_graph',
        '--project',
        projectName,
        '--name-pattern',
        `.*${pattern}.*`,
        '--format',
        'json',
        '--limit',
        '20',
      ];
      if (query.file?.trim()) {
        // file-pattern uses glob syntax, unlike name-pattern (regular expression).
        searchArgs.push('--file-pattern', normalizePath(query.file.trim()));
      }
      const search = await this.runCli(
        searchArgs,
        safePath,
        config.indexer.indexQueryTimeoutMs,
      );
      if (!search.success) {
        return empty;
      }
      searchPayload = extractJsonPayload(search.stdout);
    } catch (err: unknown) {
      if (err instanceof CliOutputParseError) {
        this.logger.warn(`search_graph parse error: ${err.message}`);
        return empty;
      }
      throw err;
    }

    const symbols = mapSearchSymbols(searchPayload, symbolName, query.file);
    if (symbols.length === 0) {
      return empty;
    }

    let target = symbols[0];
    if (query.line != null) {
      const covering = symbols.filter((s) => s.startLine != null && s.endLine != null && s.startLine <= query.line! && s.endLine >= query.line!)
        .sort((a, b) => (a.endLine! - a.startLine!) - (b.endLine! - b.startLine!));
      target = covering[0] ?? target;
    }
    if (query.file?.trim()) {
      const fileNorm = normalizePath(query.file.trim());
      const match = symbols.find(
        (s) => s.filePath && normalizePath(s.filePath).includes(fileNorm),
      );
      if (match && query.line == null) {
        target = match;
      }
    }

    const relations: CodeRelation[] = [];
    const tests: CodeSymbol[] = [];
    try {
      const fnName = target.name;
      const trace = await this.runCli(
        [
          'cli',
          '--json',
          '--quiet',
          'trace_path',
          '--project',
          projectName,
          '--function-name',
          fnName,
          '--direction',
          'both',
          '--depth',
          '2',
          '--format',
          'json',
          '--limit',
          '50',
          '--include-tests',
          'true',
        ],
        safePath,
        config.indexer.indexQueryTimeoutMs,
      );
      if (trace.success) {
        const tracePayload = extractJsonPayload(trace.stdout);
        const mapped = mapTraceRelations(tracePayload, fnName);
        relations.push(...mapped.relations);
        tests.push(...mapped.tests);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `trace_path failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const snippets: CodeSnippet[] = [];
    const qn = target.qualifiedName ?? target.name;
    try {
      const snippetResult = await this.runCli(
        [
          'cli',
          '--json',
          '--quiet',
          'get_code_snippet',
          '--project',
          projectName,
          '--qualified-name',
          qn,
          '--format',
          'json',
          '--max-lines',
          '40',
          '--source-mode',
          'full',
        ],
        safePath,
        config.indexer.indexQueryTimeoutMs,
      );
      if (snippetResult.success) {
        const payload = extractJsonPayload(snippetResult.stdout);
        const snip = mapSnippet(payload, target);
        if (snip) {
          snippets.push(snip);
        }
      }
    } catch (err: unknown) {
      this.logger.warn(
        `get_code_snippet failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const relatedFiles = uniqueStrings(
      symbols
        .map((s) => s.filePath)
        .filter((p): p is string => typeof p === 'string' && p.length > 0),
    );

    return {
      query,
      target,
      symbols,
      relatedFiles,
      relations,
      tests,
      snippets,
    };
  }

  private async resolveProjectPath(projectId: string): Promise<string | null> {
    const project = this.projects.findById(projectId);
    return project?.path ?? null;
  }

  private async tryVersion(): Promise<string | undefined> {
    const config = loadConfig();
    const result = await this.runCli(
      ['--version'],
      config.monorepoRoot,
      10_000,
    );
    if (!result.success && !result.stdout.trim()) {
      return undefined;
    }
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const match = text.match(/codebase-memory-mcp\s+(\d+\.\d+\.\d+)/i);
    if (match) {
      return match[1];
    }
    const first = text.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first?.trim();
  }

  private async probeUi(url: string, timeoutMs: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
        });
        return response.ok || response.status < 500;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  private async listProjects(cwd: string): Promise<ListedProject[]> {
    const config = loadConfig();
    const result = await this.runCli(
      [
        'cli',
        '--json',
        '--quiet',
        'list_projects',
        '--format',
        'json',
        '--detail',
        'stats',
        '--limit',
        '100',
      ],
      cwd,
      config.indexer.indexQueryTimeoutMs,
    );
    if (!result.success) {
      throw new Error(summarizeCliFailure(result));
    }
    const payload = extractJsonPayload(result.stdout);
    return mapListedProjects(payload);
  }

  private async captureGitSnapshot(projectPath: string): Promise<GitSnapshot> {
    const head = await this.commands.execute({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: projectPath,
      timeoutMs: 15_000,
    });
    const status = await this.commands.execute({
      command: 'git',
      args: ['status', '--porcelain'],
      cwd: projectPath,
      timeoutMs: 15_000,
    });

    const porcelain = status.success ? status.stdout.replace(/\r\n/g, '\n') : '';
    const fingerprint = createHash('sha256')
      .update(porcelain)
      .digest('hex')
      .slice(0, 32);
    const commit =
      head.success && head.stdout.trim().length > 0
        ? head.stdout.trim()
        : undefined;

    return {
      commit,
      porcelain,
      fingerprint,
      dirty: porcelain.trim().length > 0,
    };
  }

  private async runCli(
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<CommandResult> {
    const config = loadConfig();
    return this.commands.execute({
      command: config.indexer.codebaseMemoryCommand,
      args,
      cwd,
      timeoutMs,
    });
  }
}

function toMetadata(git: GitSnapshot): ProjectIndexMetadata {
  return {
    workingTreeFingerprint: git.fingerprint,
    workingTreeDirty: git.dirty,
    indexedAtIso: new Date().toISOString(),
  };
}

function summarizeCliFailure(result: CommandResult): string {
  if (result.timedOut) {
    return `Timeout del indexer tras ${result.durationMs} ms (Windows: el árbol de procesos hijo puede quedar vivo tras kill)`;
  }
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (stderr) {
    return stderr.slice(0, 500);
  }
  if (stdout) {
    return stdout.slice(0, 500);
  }
  if (result.exitCode === null) {
    return `No se pudo ejecutar el comando indexer (${result.command})`;
  }
  return `Indexer falló con código ${result.exitCode}`;
}

function matchListedProject(
  projects: ListedProject[],
  projectPath: string,
): ListedProject | undefined {
  const norm = normalizePath(projectPath);
  const exact = projects.find(
    (p) => p.rootPath && normalizePath(p.rootPath) === norm,
  );
  if (exact) {
    return exact;
  }
  return projects.find(
    (p) => p.rootPath && normalizePath(p.rootPath).startsWith(norm),
  );
}

function mapListedProjects(payload: unknown): ListedProject[] {
  const root = asRecord(payload);
  const list = asArray(root?.projects ?? payload);
  const out: ListedProject[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const name =
      asString(row.name) ??
      asString(row.project) ??
      asString(row.project_name);
    if (!name) {
      continue;
    }
    out.push({
      name,
      rootPath:
        asString(row.root_path) ??
        asString(row.rootPath) ??
        asString(row.path),
      nodeCount:
        asNumber(row.node_count) ??
        asNumber(row.nodes) ??
        asNumber(row.symbol_count),
      edgeCount:
        asNumber(row.edge_count) ??
        asNumber(row.edges) ??
        asNumber(row.relationship_count),
    });
  }
  return out;
}

function mapSearchSymbols(
  payload: unknown,
  symbolName: string,
  fileHint?: string,
): CodeSymbol[] {
  const root = asRecord(payload);
  const symbols: CodeSymbol[] = [];

  // Codebase Memory 0.11 grouped table format
  const groups = asArray(root?.groups);
  for (const groupItem of groups) {
    const group = asRecord(groupItem);
    if (!group) {
      continue;
    }
    const qnPrefix = asString(group.qn_prefix) ?? '';
    const filePath = asString(group.file) ?? asString(group.file_path);
    const cols = asArray(group.cols ?? root?.cols).map((c) => String(c));
    const nameIdx = cols.indexOf('name');
    const labelIdx = cols.indexOf('label');
    const linesIdx = cols.indexOf('lines');
    for (const rowItem of asArray(group.rows)) {
      if (!Array.isArray(rowItem)) {
        const row = asRecord(rowItem);
        if (!row) {
          continue;
        }
        const name = asString(row.name);
        if (!name) {
          continue;
        }
        symbols.push({
          name,
          qualifiedName:
            asString(row.qualified_name) ??
            (qnPrefix ? `${qnPrefix}.${name}` : name),
          kind: asString(row.label) ?? asString(row.kind),
          filePath: asString(row.file_path) ?? filePath,
          startLine: asNumber(row.start_line),
          endLine: asNumber(row.end_line),
        });
        continue;
      }
      const name =
        nameIdx >= 0
          ? asString(rowItem[nameIdx])
          : asString(rowItem[0]);
      if (!name) {
        continue;
      }
      const kind =
        labelIdx >= 0 ? asString(rowItem[labelIdx]) : asString(rowItem[1]);
      const linesRaw =
        linesIdx >= 0 ? asString(rowItem[linesIdx]) : asString(rowItem[2]);
      const { startLine, endLine } = parseLineRange(linesRaw);
      symbols.push({
        name,
        qualifiedName: qnPrefix ? `${qnPrefix}.${name}` : name,
        kind,
        filePath,
        startLine,
        endLine,
      });
    }
  }

  // Fallback: flat nodes/results arrays
  const nodes = asArray(
    root?.nodes ?? root?.results ?? root?.symbols ?? root?.items,
  );
  for (const item of nodes) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const name =
      asString(row.name) ??
      asString(row.symbol) ??
      asString(row.function_name);
    if (!name) {
      continue;
    }
    const filePath =
      asString(row.file_path) ??
      asString(row.filePath) ??
      asString(row.path) ??
      asString(row.file);
    symbols.push({
      name,
      qualifiedName:
        asString(row.qualified_name) ??
        asString(row.qualifiedName) ??
        asString(row.qn),
      kind:
        asString(row.label) ?? asString(row.kind) ?? asString(row.type),
      filePath,
      startLine: asNumber(row.start_line) ?? asNumber(row.startLine),
      endLine: asNumber(row.end_line) ?? asNumber(row.endLine),
    });
  }

  const exact = symbols.filter(
    (s) => s.name.toLowerCase() === symbolName.toLowerCase(),
  );
  let ranked = exact.length > 0 ? exact : symbols;
  if (fileHint?.trim()) {
    const fileNorm = normalizePath(fileHint.trim());
    const byFile = ranked.filter(
      (s) => s.filePath && normalizePath(s.filePath).includes(fileNorm),
    );
    if (byFile.length > 0) {
      ranked = byFile;
    }
  }
  return ranked;
}

function parseLineRange(
  raw: string | undefined,
): { startLine?: number; endLine?: number } {
  if (!raw) {
    return {};
  }
  const match = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!match) {
    const single = Number(raw);
    return Number.isFinite(single) ? { startLine: single } : {};
  }
  return {
    startLine: Number(match[1]),
    endLine: Number(match[2]),
  };
}

function mapTraceRelations(
  payload: unknown,
  functionName: string,
): { relations: CodeRelation[]; tests: CodeSymbol[] } {
  const relations: CodeRelation[] = [];
  const tests: CodeSymbol[] = [];
  const root = asRecord(payload);

  const callerSide = root?.callers ?? root?.inbound ?? root?.incoming;
  const calleeSide = root?.callees ?? root?.outbound ?? root?.outgoing;

  for (const item of expandTraceSide(callerSide)) {
    const name = item.name;
    if (!name) {
      continue;
    }
    relations.push({
      kind: 'caller',
      from: name,
      to: functionName,
      evidence: 'trace_path:inbound',
    });
    if (item.isTest) {
      tests.push({
        name,
        qualifiedName: item.qualifiedName,
        kind: 'Test',
        filePath: item.filePath,
      });
    }
  }

  for (const item of expandTraceSide(calleeSide)) {
    const name = item.name;
    if (!name) {
      continue;
    }
    relations.push({
      kind: 'callee',
      from: functionName,
      to: name,
      evidence: 'trace_path:outbound',
    });
    if (item.isTest) {
      tests.push({
        name,
        qualifiedName: item.qualifiedName,
        kind: 'Test',
        filePath: item.filePath,
      });
    }
  }

  // Flat edge lists
  const groups = asArray(root?.groups ?? root?.paths ?? root?.edges);
  for (const item of groups) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const from =
      asString(row.from) ?? asString(row.source) ?? asString(row.caller);
    const to =
      asString(row.to) ?? asString(row.target) ?? asString(row.callee);
    const direction = asString(row.direction);
    if (from && to) {
      if (direction === 'inbound' || to === functionName) {
        relations.push({
          kind: 'caller',
          from,
          to,
          evidence: 'trace_path:edge',
        });
      } else {
        relations.push({
          kind: 'callee',
          from,
          to,
          evidence: 'trace_path:edge',
        });
      }
    }
  }

  return { relations: dedupeRelations(relations), tests: dedupeSymbols(tests) };
}

interface TraceNode {
  name: string;
  qualifiedName?: string;
  filePath?: string;
  isTest: boolean;
}

function expandTraceSide(side: unknown): TraceNode[] {
  const out: TraceNode[] = [];
  if (Array.isArray(side)) {
    for (const item of side) {
      const name = relationNodeName(item);
      if (!name) {
        continue;
      }
      const row = asRecord(item);
      out.push({
        name,
        qualifiedName:
          asString(row?.qualified_name) ?? asString(row?.qualifiedName),
        filePath:
          asString(row?.file_path) ??
          asString(row?.filePath) ??
          asString(row?.path),
        isTest: isTestNode(item, name),
      });
    }
    return out;
  }

  const table = asRecord(side);
  if (!table) {
    return out;
  }
  const cols = asArray(table.cols).map((c) => String(c));
  const nameIdx = cols.indexOf('name');
  const testIdx = cols.indexOf('test');
  for (const groupItem of asArray(table.groups)) {
    const group = asRecord(groupItem);
    if (!group) {
      continue;
    }
    const qnPrefix = asString(group.qn_prefix) ?? '';
    const filePath = asString(group.file) ?? asString(group.file_path);
    for (const rowItem of asArray(group.rows)) {
      if (Array.isArray(rowItem)) {
        const name =
          nameIdx >= 0
            ? asString(rowItem[nameIdx])
            : asString(rowItem[0]);
        if (!name) {
          continue;
        }
        const testFlag =
          testIdx >= 0 ? rowItem[testIdx] : undefined;
        out.push({
          name,
          qualifiedName: qnPrefix ? `${qnPrefix}.${name}` : name,
          filePath,
          isTest:
            testFlag === true ||
            testFlag === 1 ||
            testFlag === 'true' ||
            isTestNode({ file_path: filePath }, name),
        });
      } else {
        const row = asRecord(rowItem);
        const name = asString(row?.name);
        if (!name) {
          continue;
        }
        out.push({
          name,
          qualifiedName:
            asString(row?.qualified_name) ??
            (qnPrefix ? `${qnPrefix}.${name}` : name),
          filePath: asString(row?.file_path) ?? filePath,
          isTest: isTestNode(rowItem, name),
        });
      }
    }
  }
  return out;
}

function isTestNode(item: unknown, name: string): boolean {
  const row = asRecord(item);
  const label =
    asString(row?.label) ?? asString(row?.kind) ?? asString(row?.type) ?? '';
  const file =
    asString(row?.file_path) ??
    asString(row?.filePath) ??
    asString(row?.path) ??
    asString(row?.file) ??
    '';
  return (
    /test/i.test(label) ||
    /\.test\.|\.spec\.|__tests__/i.test(file) ||
    /^test/i.test(name) ||
    /Test$/.test(name)
  );
}

function relationNodeName(item: unknown): string | undefined {
  if (typeof item === 'string') {
    return item;
  }
  const row = asRecord(item);
  if (!row) {
    return undefined;
  }
  return (
    asString(row.name) ??
    asString(row.function_name) ??
    asString(row.qualified_name) ??
    asString(row.qn)
  );
}

function mapSnippet(
  payload: unknown,
  target: CodeSymbol,
): CodeSnippet | null {
  const root = asRecord(payload);
  if (!root) {
    return null;
  }
  const content =
    asString(root.source) ??
    asString(root.code) ??
    asString(root.content) ??
    asString(root.text) ??
    asString(root.snippet);
  if (!content) {
    // Sometimes nested
    const inner = asRecord(root.snippet) ?? asRecord(root.result);
    const nested =
      asString(inner?.source) ??
      asString(inner?.code) ??
      asString(inner?.content);
    if (!nested) {
      return null;
    }
    return {
      symbolName: target.name,
      qualifiedName: target.qualifiedName,
      filePath:
        asString(inner?.file_path) ??
        asString(inner?.filePath) ??
        target.filePath,
      startLine:
        asNumber(inner?.start_line) ??
        asNumber(inner?.startLine) ??
        target.startLine,
      endLine:
        asNumber(inner?.end_line) ??
        asNumber(inner?.endLine) ??
        target.endLine,
      content: nested,
    };
  }
  return {
    symbolName: target.name,
    qualifiedName: target.qualifiedName,
    filePath:
      asString(root.file_path) ??
      asString(root.filePath) ??
      target.filePath,
    startLine:
      asNumber(root.start_line) ??
      asNumber(root.startLine) ??
      target.startLine,
    endLine:
      asNumber(root.end_line) ?? asNumber(root.endLine) ?? target.endLine,
    content,
  };
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = normalizePath(v);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(v);
  }
  return out;
}

function dedupeRelations(relations: CodeRelation[]): CodeRelation[] {
  const seen = new Set<string>();
  const out: CodeRelation[] = [];
  for (const r of relations) {
    const key = `${r.kind}|${r.from}|${r.to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(r);
  }
  return out;
}

function dedupeSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const seen = new Set<string>();
  const out: CodeSymbol[] = [];
  for (const s of symbols) {
    const key = `${s.qualifiedName ?? s.name}|${s.filePath ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(s);
  }
  return out;
}
