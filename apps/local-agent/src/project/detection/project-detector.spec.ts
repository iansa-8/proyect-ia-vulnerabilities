import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProjectProfile } from './project-detector';
import {
  assertExistingProjectDirectory,
  PathNotFoundError,
  PathValidationError,
  validateProjectPath,
} from '../../common/path-validation';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

describe('detectProjectProfile', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects npm + nest with scripts', () => {
    const root = makeTempDir('amp-npm-nest-');
    dirs.push(root);
    writeJson(path.join(root, 'package.json'), {
      name: 'nest-app',
      dependencies: { '@nestjs/core': '11.0.0' },
      scripts: {
        build: 'nest build',
        test: 'jest',
        'test:cov': 'jest --coverage',
        'test:e2e': 'jest --config ./test/jest-e2e.json',
        start: 'nest start',
      },
    });
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, 'nest-cli.json'), '{}');

    const profile = detectProjectProfile(root);
    expect(profile.runtime).toBe('node');
    expect(profile.framework).toBe('nest');
    expect(profile.packageManager).toBe('npm');
    expect(profile.buildCommand).toBe('npm run build');
    expect(profile.testCommand).toBe('npm run test');
    expect(profile.coverageCommand).toBe('npm run test:cov');
    expect(profile.e2eCommand).toBe('npm run test:e2e');
    expect(profile.startCommand).toBe('npm run start');
    expect(profile.hasDocker).toBe(false);
    expect(profile.hasSonar).toBe(false);
  });

  it('detects yarn and uses yarn commands', () => {
    const root = makeTempDir('amp-yarn-');
    dirs.push(root);
    writeJson(path.join(root, 'package.json'), {
      scripts: { test: 'jest', build: 'tsc' },
    });
    fs.writeFileSync(path.join(root, 'yarn.lock'), '');

    const profile = detectProjectProfile(root);
    expect(profile.packageManager).toBe('yarn');
    expect(profile.buildCommand).toBe('yarn run build');
    expect(profile.testCommand).toBe('yarn run test');
    expect(profile.coverageCommand).toBeUndefined();
  });

  it('detects pnpm and uses pnpm commands', () => {
    const root = makeTempDir('amp-pnpm-');
    dirs.push(root);
    writeJson(path.join(root, 'package.json'), {
      scripts: { test: 'vitest', 'start:dev': 'vite' },
      devDependencies: { vite: '6.0.0' },
    });
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {}');

    const profile = detectProjectProfile(root);
    expect(profile.packageManager).toBe('pnpm');
    expect(profile.framework).toBe('vite');
    expect(profile.testCommand).toBe('pnpm run test');
    expect(profile.startCommand).toBe('pnpm run start:dev');
    expect(profile.buildCommand).toBeUndefined();
  });

  it('partial scripts leave missing commands undefined; no lock leaves packageManager undefined', () => {
    const root = makeTempDir('amp-node-partial-');
    dirs.push(root);
    writeJson(path.join(root, 'package.json'), {
      scripts: { test: 'node test.js' },
    });

    const profile = detectProjectProfile(root);
    expect(profile.runtime).toBe('node');
    expect(profile.framework).toBe('node');
    expect(profile.packageManager).toBeUndefined();
    expect(profile.testCommand).toBeUndefined();
    expect(profile.buildCommand).toBeUndefined();
  });

  it('detects packageManager field without lockfile', () => {
    const root = makeTempDir('amp-pkg-field-');
    dirs.push(root);
    writeJson(path.join(root, 'package.json'), {
      packageManager: 'pnpm@9.0.0',
      scripts: { build: 'tsc' },
    });

    const profile = detectProjectProfile(root);
    expect(profile.packageManager).toBe('pnpm');
    expect(profile.buildCommand).toBe('pnpm run build');
  });

  it('detects dotnet csproj without package.json and invents no commands', () => {
    const root = makeTempDir('amp-dotnet-');
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'App.csproj'), '<Project></Project>');

    const profile = detectProjectProfile(root);
    expect(profile.runtime).toBe('dotnet');
    expect(profile.framework).toBe('dotnet');
    expect(profile.packageManager).toBeUndefined();
    expect(profile.buildCommand).toBeUndefined();
    expect(profile.testCommand).toBeUndefined();
  });

  it('sets hasDocker and hasSonar without reading sonar secrets', () => {
    const root = makeTempDir('amp-docker-sonar-');
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM node:20');
    const secretLine = 'sonar.login=super-secret-token-do-not-leak';
    fs.writeFileSync(
      path.join(root, 'sonar-project.properties'),
      `sonar.projectKey=demo\n${secretLine}\n`,
    );

    const profile = detectProjectProfile(root);
    expect(profile.hasDocker).toBe(true);
    expect(profile.hasSonar).toBe(true);
    expect(JSON.stringify(profile)).not.toContain('super-secret-token');
    expect(JSON.stringify(profile)).not.toContain('sonar.login');
  });

  it('prefers nest over vite when both markers exist', () => {
    const root = makeTempDir('amp-nest-vite-');
    dirs.push(root);
    writeJson(path.join(root, 'package.json'), {
      dependencies: { '@nestjs/core': '11.0.0', vite: '6.0.0' },
    });
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, 'nest-cli.json'), '{}');
    fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {}');

    const profile = detectProjectProfile(root);
    expect(profile.framework).toBe('nest');
  });
});

describe('path validation for project selection', () => {
  const dirs: string[] = [];

  afterEach(() => {
    delete process.env.ALLOWED_PROJECT_ROOTS;
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects nonexistent paths after validation', () => {
    const missing = path.join(os.tmpdir(), `amp-missing-${Date.now()}`);
    const absolute = validateProjectPath(missing);
    expect(() => assertExistingProjectDirectory(absolute)).toThrow(PathNotFoundError);
  });

  it('rejects path traversal', () => {
    expect(() => validateProjectPath('C:\\Users\\demo\\..\\secret')).toThrow(
      PathValidationError,
    );
  });

  it('accepts an existing temporary directory', () => {
    const root = makeTempDir('amp-exists-');
    dirs.push(root);
    const absolute = validateProjectPath(root);
    expect(() => assertExistingProjectDirectory(absolute)).not.toThrow();
  });
});
