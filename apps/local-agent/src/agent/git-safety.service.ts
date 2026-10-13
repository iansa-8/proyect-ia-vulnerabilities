import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RunOwnedChange } from '@amp/core';
import { CommandExecutionService } from '../execution/command-execution.service';

export interface GitSafetySnapshot {
  fingerprint: string;
  status: string;
  trackedDiff: string;
  stagedDiff: string;
  fileHashes: Record<string, string>;
  /** In-memory only; never returned by controllers or persisted. */
  fileContents: Record<string, string>;
}

export interface GitChangeSet {
  changes: RunOwnedChange[];
  changedFiles: string[];
  createdFiles: string[];
  deletedFiles: string[];
  diff: string;
  linesAdded: number;
  linesRemoved: number;
}

const MAX_DIFF_CHARS = 120_000;

@Injectable()
export class GitSafetyService {
  constructor(private readonly commands: CommandExecutionService) {}

  async capture(projectPath: string): Promise<GitSafetySnapshot> {
    const requests = [
      ['rev-parse', '--is-inside-work-tree'],
      ['status', '--porcelain=v1', '--untracked-files=all'],
      ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'],
      ['diff', '--binary', '--no-ext-diff', '--cached', '--'],
      ['ls-files', '-co', '--exclude-standard', '-z'],
    ] as const;
    const [repo, status, tracked, staged, files] = await Promise.all(
      requests.map((args) => this.commands.execute({
        command: 'git', args: [...args], cwd: projectPath, timeoutMs: 30_000,
      })),
    );
    if (!repo.success || repo.stdout.trim() !== 'true') {
      throw new Error('GIT_REPOSITORY_REQUIRED');
    }
    for (const result of [status, tracked, staged, files]) {
      if (!result.success || result.stdoutTruncated || result.stderrTruncated) {
        throw new Error('GIT_BASELINE_INCOMPLETE');
      }
    }
    const root = path.resolve(projectPath);
    const fileHashes: Record<string, string> = {};
    const fileContents: Record<string, string> = {};
    for (const raw of files.stdout.split('\0').filter(Boolean).sort()) {
      const relative = normalizeRelative(raw);
      const absolute = safeAbsolute(root, relative);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      const content = fs.readFileSync(absolute);
      fileHashes[relative] = hash(content);
      fileContents[relative] = content.toString('base64');
    }
    const persisted = { status: status.stdout, trackedDiff: tracked.stdout, stagedDiff: staged.stdout, fileHashes };
    return {
      ...persisted,
      fileContents,
      fingerprint: hash(Buffer.from(JSON.stringify(persisted))),
    };
  }

  compare(before: GitSafetySnapshot, after: GitSafetySnapshot): GitChangeSet {
    const files = [...new Set([...Object.keys(before.fileHashes), ...Object.keys(after.fileHashes)])].sort();
    const changes: RunOwnedChange[] = [];
    const chunks: string[] = [];
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const file of files) {
      const baselineHash = before.fileHashes[file];
      const afterHash = after.fileHashes[file];
      if (baselineHash === afterHash) continue;
      const changeType = baselineHash === undefined ? 'created' : afterHash === undefined ? 'deleted' : 'modified';
      changes.push({ file, changeType, existedBefore: baselineHash !== undefined, baselineHash, afterHash });
      const oldText = decodeText(before.fileContents[file]);
      const newText = decodeText(after.fileContents[file]);
      const oldLines = oldText === undefined ? [] : oldText.split(/\r?\n/);
      const newLines = newText === undefined ? [] : newText.split(/\r?\n/);
      linesRemoved += oldLines.length;
      linesAdded += newLines.length;
      chunks.push(renderBoundedDiff(file, oldText, newText));
    }
    const diff = chunks.join('\n').slice(0, MAX_DIFF_CHARS);
    return {
      changes,
      changedFiles: changes.map((item) => item.file),
      createdFiles: changes.filter((item) => item.changeType === 'created').map((item) => item.file),
      deletedFiles: changes.filter((item) => item.changeType === 'deleted').map((item) => item.file),
      diff,
      linesAdded,
      linesRemoved,
    };
  }

  async rollback(projectPath: string, baseline: GitSafetySnapshot): Promise<{ restoredFiles: string[]; verified: boolean }> {
    const current = await this.capture(projectPath);
    const delta = this.compare(baseline, current);
    const root = path.resolve(projectPath);
    for (const change of delta.changes) {
      const absolute = safeAbsolute(root, change.file);
      const encoded = baseline.fileContents[change.file];
      if (encoded === undefined) {
        if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) fs.rmSync(absolute);
      } else {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, Buffer.from(encoded, 'base64'));
      }
    }
    const verified = (await this.capture(projectPath)).fingerprint === baseline.fingerprint;
    return { restoredFiles: delta.changedFiles, verified };
  }

  unchanged(before: GitSafetySnapshot, after: GitSafetySnapshot): boolean {
    return before.fingerprint === after.fingerprint;
  }
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function safeAbsolute(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('INVALID_GIT_PATH');
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('INVALID_GIT_PATH');
  return absolute;
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function decodeText(encoded: string | undefined): string | undefined {
  if (encoded === undefined) return undefined;
  const content = Buffer.from(encoded, 'base64');
  return content.includes(0) ? '[binary content]' : content.toString('utf8');
}

function renderBoundedDiff(file: string, before: string | undefined, after: string | undefined): string {
  const oldLines = before === undefined ? [] : before.split(/\r?\n/);
  const newLines = after === undefined ? [] : after.split(/\r?\n/);
  const body = [
    `diff --git a/${file} b/${file}`,
    `--- ${before === undefined ? '/dev/null' : `a/${file}`}`,
    `+++ ${after === undefined ? '/dev/null' : `b/${file}`}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
  return body.slice(0, 40_000);
}
