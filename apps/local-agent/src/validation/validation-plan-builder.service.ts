import { Injectable } from '@nestjs/common';
import type { ProjectProfile, PackageManager } from '@amp/core';
import { assignNodeCommands, resolvePackageManager, collectMarkers, readPackageJson } from '../project/detection/project-detector';

export interface ValidationPlan {
  build?: string;
  unit?: string;
  coverage?: string;
  e2e?: string;
  startup?: string;
  packageManager?: PackageManager;
  framework?: string;
  runtime?: string;
}

@Injectable()
export class ValidationPlanBuilder {
  build(projectPath: string): ValidationPlan {
    const markers = collectMarkers(projectPath);
    const pkg = markers.hasPackageJson ? readPackageJson(projectPath) : null;
    const packageManager = resolvePackageManager(markers, pkg);
    const framework = detectFramework(markers, pkg);
    const runtime = detectRuntime(markers);

    const profile: ProjectProfile = {
      hasDocker: markers.hasDockerfile,
      hasSonar: markers.hasSonarProperties,
    };
    if (runtime) profile.runtime = runtime;
    if (framework) profile.framework = framework;
    if (packageManager) profile.packageManager = packageManager;

    if (pkg?.scripts && packageManager && packageManager !== 'unknown') {
      assignNodeCommands(profile, pkg.scripts, packageManager);
    }

    return {
      build: profile.buildCommand,
      unit: profile.testCommand,
      coverage: profile.coverageCommand,
      e2e: profile.e2eCommand,
      startup: profile.startCommand,
      packageManager,
      framework,
      runtime,
    };
  }
}

function detectFramework(markers: ReturnType<typeof collectMarkers>, pkg: ReturnType<typeof readPackageJson>): string | undefined {
  const deps = {
    ...pkg?.dependencies,
    ...pkg?.devDependencies,
    ...pkg?.peerDependencies,
  };
  const hasNestDep = Boolean(deps['@nestjs/core']);
  const hasNextDep = Boolean(deps.next);
  const hasViteDep = Boolean(deps.vite);

  if (markers.hasNestCli || hasNestDep) return 'nest';
  if (markers.hasNextConfig || hasNextDep) return 'next';
  if (markers.hasViteConfig || hasViteDep) return 'vite';
  if (markers.hasPackageJson) return 'node';
  if (markers.hasCsproj || markers.hasSln) return 'dotnet';
  return undefined;
}

function detectRuntime(markers: ReturnType<typeof collectMarkers>): string | undefined {
  if (markers.hasPackageJson) return 'node';
  if (markers.hasCsproj || markers.hasSln) return 'dotnet';
  return undefined;
}