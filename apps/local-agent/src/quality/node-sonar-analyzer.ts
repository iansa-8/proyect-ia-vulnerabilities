import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Injectable } from '@nestjs/common';
import type {
  ProjectProfile,
  QualityAnalysisInput,
  QualityAnalysisResult,
  QualityAnalyzer,
  QualityAnalyzerHealth,
} from '@amp/core';
import { redactSecretsInText } from '@amp/core';
import { loadConfig } from '../config/app-config';
import { CommandExecutionService } from '../execution/command-execution.service';

/**
 * Documented Sonar Scanner CLI task-id pattern (CE dashboard URL).
 * Example line:
 *   INFO: More about the report processing at http://host:9000/api/ce/task?id=AY…
 * If stdout does not match, taskId stays undefined and wait step uses CE activity.
 */
export const SONAR_CE_TASK_ID_PATTERN =
  /\/api\/ce\/task\?id=([A-Za-z0-9_-]+)/;

export function extractSonarTaskId(stdout: string): string | undefined {
  return SONAR_CE_TASK_ID_PATTERN.exec(stdout)?.[1]
    ?? /^\s*ceTaskId\s*=\s*([A-Za-z0-9_-]+)\s*$/m.exec(stdout)?.[1];
}

export function extractScannerVersion(output: string): string {
  return /\bSonarScanner(?: CLI)?\s+(\d+(?:\.\d+)+)\b/i.exec(output)?.[1] ?? 'unknown';
}

export interface SonarProjectProperties {
  projectKey?: string;
  sources?: string;
  tests?: string;
  coverage?: string;
  values?: Record<string, string>;
}

/**
 * Reads existing sonar-project.properties without writing/overwriting.
 * Only extracts known keys we may respect.
 */
export function readExistingSonarProperties(
  projectPath: string,
): SonarProjectProperties {
  const filePath = path.join(projectPath, 'sonar-project.properties');
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const out: SonarProjectProperties = { values: {} };
    // Java properties allow continuation lines; preserve the project's scopes.
    for (const line of text.replace(/\\\r?\n\s*/g, '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed.startsWith(';')) {
        continue;
      }
      const entry = /^([^\s=:]+)\s*(?:[=:]\s*|\s+)(.*)$/.exec(trimmed);
      if (!entry) {
        continue;
      }
      const [, key, raw] = entry;
      const value = raw.trim();
      out.values![key] = value;
      if (key === 'sonar.projectKey' && value) {
        out.projectKey = value;
      }
      if (key === 'sonar.sources' && value) {
        out.sources = value;
      }
      if (key === 'sonar.tests') out.tests = value;
      if (key === 'sonar.javascript.lcov.reportPaths') out.coverage = value;
    }
    return out;
  } catch {
    throw new Error('Cannot read sonar-project.properties');
  }
}

/**
 * Only detect real source directories. Coverage is never inferred as source.
 * Prefer existing sonar.sources from properties when present.
 */
export function resolveSonarSources(
  projectPath: string,
  existingSources?: string,
): string | undefined {
  if (existingSources && existingSources.trim()) {
    return existingSources.trim();
  }
  return fs.existsSync(path.join(projectPath, 'src'))
    && fs.statSync(path.join(projectPath, 'src')).isDirectory() ? 'src' : undefined;
}

export function resolveSonarScopeArgs(projectPath: string, existing: SonarProjectProperties): string[] {
  const args: string[] = [];
  const values = existing.values ?? {};
  const sources = resolveSonarSources(projectPath, existing.sources);
  if (!Object.hasOwn(values, 'sonar.sources') && sources) args.push(`-Dsonar.sources=${sources}`);
  const tests = path.join(projectPath, 'test');
  // With explicit sources, let the project own the source/test boundary.
  if (!existing.sources && !Object.hasOwn(values, 'sonar.tests') && fs.existsSync(tests) && fs.statSync(tests).isDirectory()) {
    args.push('-Dsonar.tests=test');
  }
  const lcov = path.join(projectPath, 'coverage', 'lcov.info');
  if (!Object.hasOwn(values, 'sonar.javascript.lcov.reportPaths') && fs.existsSync(lcov) && fs.statSync(lcov).isFile()) {
    args.push('-Dsonar.javascript.lcov.reportPaths=coverage/lcov.info');
  }
  if (!sources && !Object.hasOwn(values, 'sonar.exclusions')) {
    args.push('-Dsonar.exclusions=coverage/**,node_modules/**,test/**,.scannerwork/**');
  }
  return args;
}

/**
 * Node/NestJS local scanner via CommandExecutionService.
 * Prefer Nest but supports generic Node. Rejects non-node runtimes.
 * Explicit configurable scanner authentication; secrets are redacted by the executor.
 * Does not change project source or sonar-project.properties.
 */
@Injectable()
export class NodeSonarAnalyzer implements QualityAnalyzer {
  readonly name = 'node-sonar';

  constructor(private readonly commands: CommandExecutionService) {}

  supports(profile: ProjectProfile): boolean {
    const runtime = (profile.runtime ?? '').toLowerCase();
    return runtime === 'node' || runtime === 'nodejs';
  }

  async health(): Promise<QualityAnalyzerHealth> {
    const cfg = loadConfig().quality;
    const command = cfg.scannerCommand.trim() || 'sonar-scanner';
    if (!command) {
      return {
        available: false,
        analyzer: this.name,
        command,
        error: 'SONAR_SCANNER_COMMAND is empty',
      };
    }

    const cwd = loadConfig().monorepoRoot;
    const result = await this.commands.execute({
      command,
      args: ['--version'],
      cwd,
      timeoutMs: Math.min(30_000, cfg.scannerTimeoutMs),
    });

    if (!result.success) {
      return {
        available: false,
        analyzer: this.name,
        command,
        error: result.stderr || result.stdout || 'Scanner unavailable',
      };
    }

    const versionLine = extractScannerVersion(`${result.stdout}\n${result.stderr}`);

    return {
      available: true,
      analyzer: this.name,
      command,
      version: versionLine,
    };
  }

  async analyze(input: QualityAnalysisInput): Promise<QualityAnalysisResult> {
    const started = new Date();
    const startedAt = started.toISOString();
    const cfg = loadConfig().quality;
    const command = cfg.scannerCommand.trim() || 'sonar-scanner';
    const hostUrl = input.qualityConfig.baseUrl.trim().replace(/\/+$/, '');
    const projectKey = input.qualityConfig.projectKey.trim();
    const token = input.qualityConfig.authToken ?? '';

    if (!this.supports(input.projectProfile)) {
      const finished = new Date();
      return {
        success: false,
        provider: this.name,
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        error: 'NodeSonarAnalyzer only supports Node runtimes',
      };
    }

    if (!hostUrl || !projectKey) {
      const finished = new Date();
      return {
        success: false,
        provider: this.name,
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        error: 'Quality host URL and project key are required',
      };
    }

    if (!token) {
      const finished = new Date();
      return {
        success: false,
        provider: this.name,
        startedAt,
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        error: 'SONAR_TOKEN is not configured',
      };
    }

    let metadataDirectory: string | undefined;
    try {
    const existing = readExistingSonarProperties(input.projectPath);
    if (existing.projectKey && existing.projectKey !== projectKey) {
      throw new Error('Configured project key differs from sonar-project.properties; align the platform configuration before analysis');
    }
    // Prevent diagnostic options from dumping credentials into project files or CE logs.
    if (existing.values?.['sonar.scanner.dumpToFile'] || existing.values?.['sonar.verbose'] === 'true') {
      throw new Error('Disable sonar.scanner.dumpToFile and sonar.verbose before authenticated analysis');
    }
    metadataDirectory = fs.mkdtempSync(path.join(tmpdir(), 'amp-sonar-'));
    const metadataPath = path.join(metadataDirectory, 'report-task.txt');

    // Args only — never write sonar-project.properties into the analyzed repo.
    const args = [
      `-Dsonar.projectKey=${projectKey}`,
      `-Dsonar.host.url=${hostUrl}`,
      `-Dsonar.projectBaseDir=${input.projectPath}`,
      `-Dsonar.scanner.metadataFilePath=${metadataPath}`,
      ...resolveSonarScopeArgs(input.projectPath, existing),
    ];
    // Keep transient scanner extraction outside the source tree and sync folders.
    // A project that explicitly defines a working directory retains that choice.
    if (!existing.values?.['sonar.working.directory']) {
      args.push(`-Dsonar.working.directory=${path.join(metadataDirectory, 'work')}`);
    }
    if (cfg.scannerAuthMode === 'legacy-login') args.push(`-Dsonar.login=${token}`);

    if (input.qualityConfig.projectName?.trim()) {
      args.push(
        `-Dsonar.projectName=${input.qualityConfig.projectName.trim()}`,
      );
    }

    const result = await this.commands.execute({
      command,
      args,
      cwd: input.projectPath,
      env: {
        SONAR_TOKEN: cfg.scannerAuthMode === 'token-env' ? token : undefined,
        // The bundled JRE creates a local-domain socket for HttpClient. A
        // short 8.3 TEMP path inherited from a launcher can make that socket
        // invalid on Windows. Use the canonical per-user temp directory only
        // for the scanner child process.
      },
      timeoutMs: cfg.scannerTimeoutMs,
      killProcessTree: true,
    });

    const finished = new Date();
    const finishedAt = finished.toISOString();
    const durationMs = finished.getTime() - started.getTime();
    const secrets = [token];
    const stdout = redactSecretsInText(result.stdout, secrets);
    const stderr = redactSecretsInText(result.stderr, secrets);
    let taskId = extractSonarTaskId(`${stdout}\n${stderr}`);
    if (result.success && fs.existsSync(metadataPath)) {
      taskId = extractSonarTaskId(fs.readFileSync(metadataPath, 'utf8')) ?? taskId;
    }

    if (result.timedOut) {
      return {
        success: false,
        provider: this.name,
        startedAt,
        finishedAt,
        durationMs,
        taskId,
        stdout,
        stderr,
        error: 'Scanner timed out',
      };
    }

    if (!result.success) {
      return {
        success: false,
        provider: this.name,
        startedAt,
        finishedAt,
        durationMs,
        taskId,
        stdout,
        stderr,
        error:
          stderr ||
          stdout ||
          `Scanner exited with code ${String(result.exitCode)}`,
      };
    }

    return {
      success: true,
      provider: this.name,
      startedAt,
      finishedAt,
      durationMs,
      taskId,
      stdout,
      stderr,
    };
    } catch (err: unknown) {
      const finished = new Date();
      return {
        success: false, provider: this.name, startedAt,
        finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(),
        error: redactSecretsInText(err instanceof Error ? err.message : String(err), [token]),
      };
    } finally {
      if (metadataDirectory) {
        try { fs.rmSync(metadataDirectory, { recursive: true, force: true }); }
        catch { /* Cleanup failure must not replace the scanner result. No credentials are written here. */ }
      }
    }
  }
}
