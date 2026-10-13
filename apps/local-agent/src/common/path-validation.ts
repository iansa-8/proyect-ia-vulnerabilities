import fs from 'node:fs';
import path from 'node:path';

export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathValidationError';
  }
}

export class PathNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathNotFoundError';
  }
}

/**
 * Basic path safety checks. Does not scan the filesystem deeply.
 * Rejects empty paths, null bytes, and obvious path traversal segments.
 * Optionally enforces ALLOWED_PROJECT_ROOTS (comma-separated absolute roots).
 */
export function validateProjectPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new PathValidationError('Path must not be empty');
  }
  if (trimmed.includes('\0')) {
    throw new PathValidationError('Path must not contain null bytes');
  }

  // Check raw segments before normalize collapses ".."
  const rawSegments = trimmed.split(/[/\\]+/);
  if (rawSegments.some((segment) => segment === '..')) {
    throw new PathValidationError('Path must not contain ".." segments');
  }

  const normalized = path.normalize(trimmed);
  if (!path.isAbsolute(normalized)) {
    throw new PathValidationError('Path must be absolute');
  }

  // Reject normalized paths that still escape via parent references
  if (normalized.split(/[/\\]+/).includes('..')) {
    throw new PathValidationError('Path must not contain ".." segments');
  }

  assertWithinAllowedRoots(normalized);
  return normalized;
}

/**
 * Ensures the absolute path exists and is a directory.
 * Call after validateProjectPath.
 */
export function assertExistingProjectDirectory(absolutePath: string): void {
  if (!fs.existsSync(absolutePath)) {
    throw new PathNotFoundError('Path does not exist');
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    throw new PathNotFoundError('Path does not exist');
  }
  if (!stats.isDirectory()) {
    throw new PathNotFoundError('Path is not a directory');
  }
}

function assertWithinAllowedRoots(absolutePath: string): void {
  const raw = process.env.ALLOWED_PROJECT_ROOTS?.trim();
  if (!raw) {
    return;
  }
  const roots = raw
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.normalize(r));
  if (roots.length === 0) {
    return;
  }

  const resolved = path.resolve(absolutePath);
  const allowed = roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolved);
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  });

  if (!allowed) {
    throw new PathValidationError('Path is outside allowed project roots');
  }
}
