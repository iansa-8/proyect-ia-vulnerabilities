import fs from 'node:fs';
import path from 'node:path';

export interface IndexerConfig {
  provider: string;
  codebaseMemoryCommand: string;
  codebaseMemoryUiUrl: string;
  indexContextMaxSymbols: number;
  indexContextMaxFiles: number;
  indexContextMaxSnippets: number;
  /** Max characters kept per snippet after budget cut. */
  indexContextMaxSnippetChars: number;
  /** Timeout for index_repository (longer than default command timeout). */
  indexCommandTimeoutMs: number;
  /** Timeout for lightweight CLI ops (list/search/trace/snippet). */
  indexQueryTimeoutMs: number;
  /** Timeout for Graph UI HTTP probe. */
  uiProbeTimeoutMs: number;
}

export interface QualityConfig {
  /** Global Sonar/quality server URL from env (optional per-project override). */
  sonarUrl: string;
  /** Origins allowed for per-project Sonar URL overrides. */
  sonarAllowedOrigins: string[];
  /** Global token from env â€” never logged or returned to clients. */
  sonarToken: string;
  /**
   * Auth scheme for Sonar Web API.
   * Sonar 9.9.8 authenticated endpoints require basic-token (token as username).
   */
  sonarAuthMode: 'basic-token' | 'bearer';
  /** Default page size for issue downloads. */
  defaultPageSize: number;
  downloadMaxIssues: number;
  /**
   * Scanner executable name on PATH or absolute path.
   * Do not hardcode machine-specific paths in source.
   */
  scannerCommand: string;
  scannerAuthMode: 'legacy-login' | 'token-env';
  /** Timeout for local scanner process via CommandExecutionService. */
  scannerTimeoutMs: number;
  /** Polling interval while waiting for CE processing. */
  analysisPollIntervalMs: number;
  /** Max wait for CE processing after local scanner finishes. */
  analysisTimeoutMs: number;
}

export interface AppConfig {
  port: number;
  host: string;
  corsOrigin: string;
  sqlitePath: string;
  monorepoRoot: string;
  /** NestJS log level: 'log' | 'debug' | 'verbose'. Controls pipeline/LLM/agent tracing. */
  logLevel: 'log' | 'debug' | 'verbose';
  indexer: IndexerConfig;
  quality: QualityConfig;
  agent: {
    provider: string;
    codexCommand: string;
    codexTimeoutMs: number;
    opencodeCommand: string;
    opencodeTimeoutMs: number;
    /** Config-home isolated from a broken or inaccessible user .config folder. */
    opencodeConfigHome: string;
    monorepoRoot: string;
    persistRawResponse: boolean;
    rawResponseMaxChars: number;
    promptPreviewMaxChars: number;
  };
  llm: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    batchConcurrency: number;
    promptPreviewMaxChars: number;
  };
}

function resolveMonorepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
          name?: string;
        };
        if (pkg.name === 'ai-modernization-platform') {
          return dir;
        }
      } catch {
        // continue walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return process.cwd();
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function resolveSqlitePath(root: string): string {
  const sqliteRelative = process.env.SQLITE_PATH ?? 'data/app.sqlite';
  return path.isAbsolute(sqliteRelative)
    ? sqliteRelative
    : path.join(root, sqliteRelative);
}

function buildIndexerConfig(): IndexerConfig {
  return {
    provider: (process.env.INDEXER_PROVIDER ?? 'codebase-memory').trim(),
    codebaseMemoryCommand: (
      process.env.CODEBASE_MEMORY_COMMAND ?? 'codebase-memory-mcp'
    ).trim(),
    codebaseMemoryUiUrl: (
      process.env.CODEBASE_MEMORY_UI_URL ?? 'http://localhost:9749'
    ).trim(),
    indexContextMaxSymbols: readPositiveInt(
      process.env.INDEX_CONTEXT_MAX_SYMBOLS,
      20,
    ),
    indexContextMaxFiles: readPositiveInt(
      process.env.INDEX_CONTEXT_MAX_FILES,
      10,
    ),
    indexContextMaxSnippets: readPositiveInt(
      process.env.INDEX_CONTEXT_MAX_SNIPPETS,
      10,
    ),
    indexContextMaxSnippetChars: readPositiveInt(
      process.env.INDEX_CONTEXT_MAX_SNIPPET_CHARS,
      2000,
    ),
    indexCommandTimeoutMs: readPositiveInt(
      process.env.INDEX_COMMAND_TIMEOUT_MS,
      600_000,
    ),
    indexQueryTimeoutMs: readPositiveInt(
      process.env.INDEX_QUERY_TIMEOUT_MS,
      60_000,
    ),
    uiProbeTimeoutMs: readPositiveInt(
      process.env.CODEBASE_MEMORY_UI_PROBE_TIMEOUT_MS,
      1500,
    ),
  };
}

export function loadConfig(): AppConfig {
  const root = resolveMonorepoRoot();
  const sqlitePath = resolveSqlitePath(root);

  return {
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? '127.0.0.1',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    sqlitePath,
    monorepoRoot: root,
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    indexer: buildIndexerConfig(),
    quality: {
      sonarUrl: (process.env.SONAR_URL ?? '').trim(),
      sonarAllowedOrigins: parseOrigins(process.env.SONAR_ALLOWED_ORIGINS),
      sonarToken: (process.env.SONAR_TOKEN ?? '').trim(),
      sonarAuthMode: parseAuthMode(process.env.SONAR_AUTH_MODE),
      defaultPageSize: readPositiveInt(process.env.QUALITY_PAGE_SIZE, 50),
      downloadMaxIssues: readPositiveInt(process.env.QUALITY_DOWNLOAD_MAX_ISSUES, 100_000),
      scannerCommand: (process.env.SONAR_SCANNER_COMMAND ?? 'sonar-scanner').trim(),
      scannerAuthMode: parseScannerAuthMode(process.env.SONAR_SCANNER_AUTH_MODE),
      scannerTimeoutMs: readPositiveInt(
        process.env.SONAR_SCANNER_TIMEOUT_MS,
        600_000,
      ),
      analysisPollIntervalMs: readPositiveInt(
        process.env.SONAR_ANALYSIS_POLL_INTERVAL_MS,
        2_000,
      ),
      analysisTimeoutMs: readPositiveInt(
        process.env.SONAR_ANALYSIS_TIMEOUT_MS,
        120_000,
      ),
    },
    agent: {
      // Keep CLI selection explicit/configurable; deployments may not inherit the desktop PATH.
      provider: (process.env.AGENT_PROVIDER ?? 'codex').trim(),
      codexCommand: (process.env.CODEX_COMMAND ?? 'codex').trim(),
      codexTimeoutMs: readPositiveInt(process.env.CODEX_TIMEOUT_MS, 120_000),
      opencodeCommand: (process.env.OPENCODE_COMMAND ?? 'opencode').trim(),
      opencodeTimeoutMs: readPositiveInt(process.env.OPENCODE_TIMEOUT_MS, 300_000),
      opencodeConfigHome: (
        process.env.OPENCODE_CONFIG_HOME ??
        path.join(process.env.TEMP ?? process.env.TMP ?? root, 'amp-opencode')
      ).trim(),
      monorepoRoot: root,
      persistRawResponse:
        (process.env.CODEX_PERSIST_RAW_RESPONSE ?? 'false').toLowerCase() ===
        'true',
      rawResponseMaxChars: readPositiveInt(
        process.env.CODEX_RAW_RESPONSE_MAX_CHARS,
        20_000,
      ),
      promptPreviewMaxChars: readPositiveInt(
        process.env.CODEX_PROMPT_PREVIEW_MAX_CHARS,
        20_000,
      ),
    },
    llm: {
      provider: (process.env.LLM_PROVIDER ?? 'litellm').trim(),
      baseUrl: (process.env.LITELLM_BASE_URL ?? 'http://localhost:4000').trim().replace(/\/$/, ''),
      apiKey: (process.env.LITELLM_API_KEY ?? '').trim(),
      model: (process.env.LITELLM_MODEL ?? '').trim(),
      timeoutMs: readPositiveInt(process.env.LLM_TIMEOUT_MS, 60_000),
      maxInputTokens: readPositiveInt(process.env.AI_PROPOSE_MAX_INPUT_TOKENS, 3_000),
      maxOutputTokens: readPositiveInt(process.env.AI_PROPOSE_MAX_OUTPUT_TOKENS, 1_200),
      batchConcurrency: Math.min(4, readPositiveInt(process.env.AI_PROPOSE_BATCH_CONCURRENCY, 2)),
      promptPreviewMaxChars: readPositiveInt(process.env.LLM_PROMPT_PREVIEW_MAX_CHARS, 14_000),
    },
  };
}

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseAuthMode(
  raw: string | undefined,
): 'basic-token' | 'bearer' {
  const value = (raw ?? 'basic-token').trim().toLowerCase();
  if (value === 'bearer') {
    return 'bearer';
  }
  return 'basic-token';
}

function parseLogLevel(raw: string | undefined): 'log' | 'debug' | 'verbose' {
  const value = (raw ?? 'log').trim().toLowerCase();
  if (value === 'debug') {
    return 'debug';
  }
  if (value === 'verbose') {
    return 'verbose';
  }
  return 'log';
}

function parseScannerAuthMode(raw: string | undefined): 'legacy-login' | 'token-env' {
  const mode = (raw ?? 'token-env').trim();
  if (mode !== 'legacy-login' && mode !== 'token-env') {
    throw new Error('SONAR_SCANNER_AUTH_MODE must be legacy-login or token-env');
  }
  return mode;
}
