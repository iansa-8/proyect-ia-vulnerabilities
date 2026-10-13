import fs from 'node:fs';
import path from 'node:path';
import type { PackageManager, ProjectProfile } from '@amp/core';

interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  packageManager?: string;
  jest?: unknown;
}

export interface DetectionMarkers {
  hasPackageJson: boolean;
  hasPackageLock: boolean;
  hasYarnLock: boolean;
  hasPnpmLock: boolean;
  hasBunLock: boolean;
  hasNestCli: boolean;
  hasViteConfig: boolean;
  hasNextConfig: boolean;
  hasJestConfig: boolean;
  hasDockerfile: boolean;
  hasSonarProperties: boolean;
  hasCsproj: boolean;
  hasSln: boolean;
}

/**
 * Detects a lightweight ProjectProfile from top-level markers only.
 * Never reads sonar-project.properties contents (tokens stay on disk).
 */
export function detectProjectProfile(projectRoot: string): ProjectProfile {
  const markers = collectMarkers(projectRoot);
  const pkg = markers.hasPackageJson ? readPackageJson(projectRoot) : null;

  const hasDocker = markers.hasDockerfile;
  const hasSonar = markers.hasSonarProperties;

  const packageManager = resolvePackageManager(markers, pkg);
  const framework = resolveFramework(markers, pkg);
  const runtime = resolveRuntime(markers);

  const profile: ProjectProfile = {
    hasDocker,
    hasSonar,
  };

  if (runtime) {
    profile.runtime = runtime;
  }
  if (framework) {
    profile.framework = framework;
  }
  if (packageManager) {
    profile.packageManager = packageManager;
  }

  if (pkg?.scripts && packageManager && packageManager !== 'unknown') {
    assignNodeCommands(profile, pkg.scripts, packageManager);
  } else if (pkg?.scripts && !packageManager) {
    // package.json present but no lock / packageManager field — still expose
    // scripts with npm as the only safe runner when scripts exist and user
    // has not declared a manager. Prefer leaving packageManager undefined and
    // still building npm run commands only when we decide npm is implied.
    // Spec: do not invent packageManager; leave commands using npm only if
    // packageManager field or lock exists. So leave commands undefined.
  }

  return profile;
}

export function collectMarkers(projectRoot: string): DetectionMarkers {
  const entries = safeReaddir(projectRoot);
  const lower = new Set(entries.map((e) => e.toLowerCase()));

  return {
    hasPackageJson: lower.has('package.json'),
    hasPackageLock: lower.has('package-lock.json'),
    hasYarnLock: lower.has('yarn.lock'),
    hasPnpmLock: lower.has('pnpm-lock.yaml'),
    hasBunLock: lower.has('bun.lockb'),
    hasNestCli: lower.has('nest-cli.json'),
    hasViteConfig: entries.some((e) => /^vite\.config\.(ts|js|mjs|cjs)$/i.test(e)),
    hasNextConfig: entries.some((e) => /^next\.config\.(ts|js|mjs|cjs)$/i.test(e)),
    hasJestConfig:
      entries.some((e) => /^jest\.config\.(ts|js|mjs|cjs)$/i.test(e)) ||
      hasJestKeyInPackageJson(projectRoot, lower.has('package.json')),
    hasDockerfile: lower.has('dockerfile'),
    hasSonarProperties: lower.has('sonar-project.properties'),
    hasCsproj: entries.some((e) => e.toLowerCase().endsWith('.csproj')),
    hasSln: entries.some((e) => e.toLowerCase().endsWith('.sln')),
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function hasJestKeyInPackageJson(projectRoot: string, hasPkg: boolean): boolean {
  if (!hasPkg) {
    return false;
  }
  const pkg = readPackageJson(projectRoot);
  return pkg !== null && pkg.jest !== undefined;
}

export function readPackageJson(projectRoot: string): PackageJsonShape | null {
  const filePath = path.join(projectRoot, 'package.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as PackageJsonShape;
  } catch {
    return null;
  }
}

export function resolvePackageManager(
  markers: DetectionMarkers,
  pkg: PackageJsonShape | null,
): PackageManager | undefined {
  if (markers.hasBunLock) {
    return 'bun';
  }
  if (markers.hasPnpmLock) {
    return 'pnpm';
  }
  if (markers.hasYarnLock) {
    return 'yarn';
  }
  if (markers.hasPackageLock) {
    return 'npm';
  }
  if (!markers.hasPackageJson) {
    return undefined;
  }
  const field = pkg?.packageManager?.trim();
  if (!field) {
    return undefined;
  }
  const name = field.split('@')[0]?.toLowerCase();
  if (name === 'npm' || name === 'yarn' || name === 'pnpm' || name === 'bun') {
    return name;
  }
  return undefined;
}

/**
 * Nest > Next > Vite > node (most specific app stack wins).
 */
function resolveFramework(
  markers: DetectionMarkers,
  pkg: PackageJsonShape | null,
): string | undefined {
  const deps = {
    ...pkg?.dependencies,
    ...pkg?.devDependencies,
    ...pkg?.peerDependencies,
  };
  const hasNestDep = Boolean(deps['@nestjs/core']);
  const hasNextDep = Boolean(deps.next);
  const hasViteDep = Boolean(deps.vite);

  if (markers.hasNestCli || hasNestDep) {
    return 'nest';
  }
  if (markers.hasNextConfig || hasNextDep) {
    return 'next';
  }
  if (markers.hasViteConfig || hasViteDep) {
    return 'vite';
  }
  if (markers.hasPackageJson) {
    return 'node';
  }
  if (markers.hasCsproj || markers.hasSln) {
    return 'dotnet';
  }
  return undefined;
}

/**
 * Primary runtime: node if package.json exists; otherwise dotnet if csproj/sln.
 * When both exist, runtime stays "node" (limitation documented in Phase 2 report).
 */
function resolveRuntime(markers: DetectionMarkers): string | undefined {
  if (markers.hasPackageJson) {
    return 'node';
  }
  if (markers.hasCsproj || markers.hasSln) {
    return 'dotnet';
  }
  return undefined;
}

export function assignNodeCommands(
  profile: ProjectProfile,
  scripts: Record<string, string>,
  packageManager: PackageManager,
): void {
  const build = scriptCommand(packageManager, scripts, 'build');
  const test = scriptCommand(packageManager, scripts, 'test');
  const coverage = scriptCommand(packageManager, scripts, 'test:cov');
  const e2e = scriptCommand(packageManager, scripts, 'test:e2e');
  // Prefer start:dev for NestJS; dev for Next.js/Vite; fallback to start
  const start =
    scriptCommand(packageManager, scripts, 'start:dev') ??
    scriptCommand(packageManager, scripts, 'dev') ??
    scriptCommand(packageManager, scripts, 'start');

  if (build) profile.buildCommand = build;
  if (test) profile.testCommand = test;
  if (coverage) profile.coverageCommand = coverage;
  if (e2e) profile.e2eCommand = e2e;
  if (start) profile.startCommand = start;
}

function scriptCommand(
  packageManager: PackageManager,
  scripts: Record<string, string>,
  scriptName: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
    return undefined;
  }
  switch (packageManager) {
    case 'yarn':
      return `yarn run ${scriptName}`;
    case 'pnpm':
      return `pnpm run ${scriptName}`;
    case 'bun':
      return `bun run ${scriptName}`;
    case 'npm':
    case 'unknown':
    default:
      return `npm run ${scriptName}`;
  }
}
