export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'unknown';

/**
 * Lightweight project profile produced by local marker detection (Phase 2).
 */
export interface ProjectProfile {
  runtime?: string;
  framework?: string;
  packageManager?: PackageManager;
  buildCommand?: string;
  testCommand?: string;
  coverageCommand?: string;
  e2eCommand?: string;
  startCommand?: string;
  hasDocker: boolean;
  hasSonar: boolean;
}

export type ProjectCommandKey =
  | 'buildCommand'
  | 'testCommand'
  | 'coverageCommand'
  | 'e2eCommand'
  | 'startCommand';

/** User overrides for detected commands. Empty string means "do not run". */
export type ProjectCommandOverrides = {
  [K in ProjectCommandKey]?: string;
};

export const PROJECT_COMMAND_KEYS: readonly ProjectCommandKey[] = [
  'buildCommand',
  'testCommand',
  'coverageCommand',
  'e2eCommand',
  'startCommand',
] as const;

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  /** Detected profile as last persisted from filesystem markers. */
  profile?: ProjectProfile;
  /** Optional command overrides stored in SQLite. */
  commandOverrides?: ProjectCommandOverrides;
  createdAt: string;
  updatedAt: string;
}

/**
 * Applies command overrides on top of a detected profile.
 * An override of "" clears the command (do not run).
 */
export function mergeProjectProfile(
  detected: ProjectProfile,
  overrides?: ProjectCommandOverrides,
): ProjectProfile {
  const result: ProjectProfile = { ...detected };
  if (!overrides) {
    return result;
  }
  for (const key of PROJECT_COMMAND_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) {
      continue;
    }
    const value = overrides[key];
    if (value === undefined) {
      continue;
    }
    if (value.trim() === '') {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}
