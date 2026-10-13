import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QualityAnalysisInput } from '@amp/core';
import { NodeSonarAnalyzer, extractScannerVersion, extractSonarTaskId, readExistingSonarProperties, resolveSonarScopeArgs } from './node-sonar-analyzer';
import type { CommandExecutionService } from '../execution/command-execution.service';

describe('Node Sonar baseline configuration', () => {
  let dir: string;
  let input: QualityAnalysisInput;
  const token = 'fixture-private-token';
  const savedMode = process.env.SONAR_SCANNER_AUTH_MODE;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-sonar-test-'));
    process.env.SONAR_SCANNER_AUTH_MODE = 'token-env';
    input = {
      projectId: 'p1', projectPath: dir,
      projectProfile: { runtime: 'node', framework: 'nestjs', hasDocker: false, hasSonar: false },
      qualityConfig: { baseUrl: 'http://sonar.test', projectKey: 'demo', authToken: token },
    };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedMode === undefined) delete process.env.SONAR_SCANNER_AUTH_MODE;
    else process.env.SONAR_SCANNER_AUTH_MODE = savedMode;
  });
  function analyzer(execute: jest.Mock) {
    return new NodeSonarAnalyzer({ execute } as unknown as CommandExecutionService);
  }
  it.each(['legacy-login', 'token-env'])('authenticates with explicit %s and sanitizes both streams', async (mode) => {
    process.env.SONAR_SCANNER_AUTH_MODE = mode;
    const execute = jest.fn().mockResolvedValue({ success: true, stdout: 'EXECUTION SUCCESS ' + token, stderr: token });
    const result = await analyzer(execute).analyze(input);
    const request = execute.mock.calls[0][0];
    expect(request.env.SONAR_TOKEN).toBe(mode === 'token-env' ? token : undefined);
    expect(request.args.includes('-Dsonar.login=' + token)).toBe(mode === 'legacy-login');
    expect(request.cwd).toBe(dir);
    expect(request.timeoutMs).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(result.startedAt).toBeDefined();
    expect(result.finishedAt).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('rejects missing token without execution', async () => {
    input.qualityConfig.authToken = undefined;
    const execute = jest.fn();
    expect((await analyzer(execute).analyze(input)).success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it('uses freshly produced report-task metadata before console evidence', async () => {
    let metadataPath = '';
    const execute = jest.fn().mockImplementation(async (request) => {
      metadataPath = request.args.find((arg: string) => arg.startsWith('-Dsonar.scanner.metadataFilePath=')).split('=').slice(1).join('=');
      fs.writeFileSync(metadataPath, 'projectKey=demo\nceTaskId=REAL_metadata-123\n');
      return { success: true, stdout: 'EXECUTION SUCCESS\nhttp://sonar.test/api/ce/task?id=console-id', stderr: '' };
    });
    expect((await analyzer(execute).analyze(input)).taskId).toBe('REAL_metadata-123');
    expect(fs.existsSync(metadataPath)).toBe(false);
  });
  it.each([
    ['configuration file: C:/scanner/conf', 'unknown'],
    ['INFO Scanner configuration file: foo\nINFO SonarScanner CLI 8.1.0.6389\nJava 17', '8.1.0.6389'],
    ['INFO: SonarScanner 4.8.0.2856', '4.8.0.2856'],
  ])('parses version from %s', (output, expected) => {
    expect(extractScannerVersion(output)).toBe(expected);
  });
  it('extracts CE URLs and metadata, never invents an ID', () => {
    expect(extractSonarTaskId('12:34 INFO More about report processing at http://host/api/ce/task?id=AY_abc-123')).toBe('AY_abc-123');
    expect(extractSonarTaskId('ceTaskId=AY_abc-123\r\n')).toBe('AY_abc-123');
    expect(extractSonarTaskId('EXECUTION SUCCESS')).toBeUndefined();
  });
  it('detects separate existing sources, tests and LCOV only', () => {
    expect(resolveSonarScopeArgs(dir, {})).not.toContain('-Dsonar.sources=src');
    for (const name of ['src', 'test', 'coverage']) fs.mkdirSync(path.join(dir, name));
    expect(resolveSonarScopeArgs(dir, {})).toEqual(['-Dsonar.sources=src', '-Dsonar.tests=test']);
    fs.writeFileSync(path.join(dir, 'coverage/lcov.info'), '');
    expect(resolveSonarScopeArgs(dir, {})).toEqual(['-Dsonar.sources=src', '-Dsonar.tests=test', '-Dsonar.javascript.lcov.reportPaths=coverage/lcov.info']);
  });
  it('respects explicit project scope without modifying properties', async () => {
    const props = 'sonar.projectKey=demo\nsonar.sources=lib\nsonar.tests=spec\nsonar.javascript.lcov.reportPaths=reports/coverage.info\n';
    fs.writeFileSync(path.join(dir, 'sonar-project.properties'), props);
    fs.mkdirSync(path.join(dir, 'src'));
    expect(resolveSonarScopeArgs(dir, readExistingSonarProperties(dir))).toEqual([]);
    const execute = jest.fn().mockResolvedValue({ success: true, stdout: 'EXECUTION SUCCESS', stderr: '' });
    await analyzer(execute).analyze(input);
    expect(fs.readFileSync(path.join(dir, 'sonar-project.properties'), 'utf8')).toBe(props);
  });
  it.each(['sonar.projectKey=other', 'sonar.verbose=true', 'sonar.scanner.dumpToFile=dump.txt'])('rejects unsafe configuration %s', async (props) => {
    fs.writeFileSync(path.join(dir, 'sonar-project.properties'), props);
    const execute = jest.fn();
    expect((await analyzer(execute).analyze(input)).success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it('sanitizes synchronous execution exceptions', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('failed ' + token));
    const result = await analyzer(execute).analyze(input);
    expect(result.success).toBe(false);
    expect(result.error).not.toContain(token);
  });
});
