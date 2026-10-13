import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkingTreeSnapshot } from '../../agent/working-tree-guard.service';

export function captureProposalFileBaseline(projectPath: string, files: string[]): WorkingTreeSnapshot {
  const root = path.resolve(projectPath);
  const fileHashes: Record<string, string> = {};
  for (const raw of [...new Set(files.map((file) => normalizeFile(root, file)).filter(Boolean))].sort()) {
    const absolute = path.resolve(root, raw);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('CONTEXT_PATH_OUTSIDE_PROJECT');
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      fileHashes[raw] = 'missing';
      continue;
    }
    fileHashes[raw] = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  }
  if (!Object.keys(fileHashes).length) throw new Error('CONTEXT_UNAVAILABLE');
  return {
    status: '',
    trackedDiff: '',
    stagedDiff: '',
    fileHashes,
    fingerprint: createHash('sha256').update(JSON.stringify(fileHashes)).digest('hex'),
  };
}

function normalizeFile(root: string, file: string): string {
  const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.replace(/\\/g, '/');
}
