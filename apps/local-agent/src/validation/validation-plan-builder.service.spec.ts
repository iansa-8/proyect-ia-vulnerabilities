import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ValidationPlanBuilder } from './validation-plan-builder.service';

describe('ValidationPlanBuilder', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-validation-plan-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('detects npm + nest project with all scripts', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: {
        build: 'nest build',
        test: 'jest',
        'test:cov': 'jest --coverage',
        'test:e2e': 'jest --config ./test/jest-e2e.json',
        start: 'node dist/main',
        'start:dev': 'nest start --watch',
      },
      dependencies: { '@nestjs/core': '^10.0.0' },
      devDependencies: { jest: '^29.0.0' },
    }, null, 2));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(root, 'nest-cli.json'), '{}');

    const plan = new ValidationPlanBuilder().build(root);

    expect(plan.packageManager).toBe('npm');
    expect(plan.framework).toBe('nest');
    expect(plan.runtime).toBe('node');
    expect(plan.build).toBe('npm run build');
    expect(plan.unit).toBe('npm run test');
    expect(plan.coverage).toBe('npm run test:cov');
    expect(plan.e2e).toBe('npm run test:e2e');
    expect(plan.startup).toBe('npm run start:dev');
  });

  it('detects pnpm + nextjs project', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: {
        build: 'next build',
        test: 'jest',
        dev: 'next dev',
      },
      dependencies: { next: '^14.0.0' },
    }, null, 2));
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfile');

    const plan = new ValidationPlanBuilder().build(root);

    expect(plan.packageManager).toBe('pnpm');
    expect(plan.framework).toBe('next');
    expect(plan.runtime).toBe('node');
    expect(plan.build).toBe('pnpm run build');
    expect(plan.unit).toBe('pnpm run test');
    expect(plan.startup).toBe('pnpm run dev');
  });

  it('detects yarn + vite project', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: {
        build: 'vite build',
        test: 'vitest',
        dev: 'vite',
      },
      dependencies: { vite: '^5.0.0' },
    }, null, 2));
    fs.writeFileSync(path.join(root, 'yarn.lock'), 'lockfile');

    const plan = new ValidationPlanBuilder().build(root);

    expect(plan.packageManager).toBe('yarn');
    expect(plan.framework).toBe('vite');
    expect(plan.build).toBe('yarn run build');
    expect(plan.unit).toBe('yarn run test');
    expect(plan.startup).toBe('yarn run dev');
  });

  it('detects bun project', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: {
        build: 'bun build',
        test: 'bun test',
        dev: 'bun run dev.ts',
      },
    }, null, 2));
    fs.writeFileSync(path.join(root, 'bun.lockb'), 'lockfile');

    const plan = new ValidationPlanBuilder().build(root);

    expect(plan.packageManager).toBe('bun');
    expect(plan.build).toBe('bun run build');
    expect(plan.unit).toBe('bun run test');
  });

  it('detects dotnet project', () => {
    fs.writeFileSync(path.join(root, 'MyProject.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');

    const plan = new ValidationPlanBuilder().build(root);

    expect(plan.packageManager).toBeUndefined();
    expect(plan.framework).toBe('dotnet');
    expect(plan.runtime).toBe('dotnet');
    expect(plan.build).toBeUndefined();
    expect(plan.unit).toBeUndefined();
  });

  it('returns empty plan for unknown directory', () => {
    const plan = new ValidationPlanBuilder().build(root);
    expect(plan).toEqual({
      build: undefined,
      unit: undefined,
      coverage: undefined,
      e2e: undefined,
      startup: undefined,
      packageManager: undefined,
      framework: undefined,
      runtime: undefined,
    });
  });

  it('handles package.json without lockfile or packageManager field', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { build: 'echo build', test: 'echo test' },
    }, null, 2));

    const plan = new ValidationPlanBuilder().build(root);

    expect(plan.packageManager).toBeUndefined();
    expect(plan.framework).toBe('node');
    // Sin lockfile ni packageManager field, no se asignan comandos
    expect(plan.build).toBeUndefined();
  });
});