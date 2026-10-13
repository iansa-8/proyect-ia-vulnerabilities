import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandExecutionService } from '../execution/command-execution.service';
import { GitSafetyService, type GitSafetySnapshot } from './git-safety.service';

const encode = (value: string) => Buffer.from(value).toString('base64');
const snap = (fingerprint: string, files: Record<string, string>): GitSafetySnapshot => ({
  fingerprint, status: '', trackedDiff: '', stagedDiff: '',
  fileHashes: Object.fromEntries(Object.entries(files).map(([file, value]) => [file, `hash:${value}`])),
  fileContents: Object.fromEntries(Object.entries(files).map(([file, value]) => [file, encode(value)])),
});

describe('GitSafetyService', () => {
  const commands = {} as CommandExecutionService;

  it('classifies modified, created, and deleted run-owned files', () => {
    const service = new GitSafetyService(commands);
    const before = snap('before', { 'dirty.ts': 'developer A', 'deleted.ts': 'keep' });
    const after = snap('after', { 'dirty.ts': 'developer A + agent B', 'created.ts': 'new' });
    const result = service.compare(before, after);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'dirty.ts', changeType: 'modified', existedBefore: true }),
      expect.objectContaining({ file: 'created.ts', changeType: 'created', existedBefore: false }),
      expect.objectContaining({ file: 'deleted.ts', changeType: 'deleted', existedBefore: true }),
    ]));
  });

  it('rollback preserves developer changes, restores deleted files, removes only created files, and verifies baseline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-git-safety-'));
    fs.writeFileSync(path.join(dir, 'dirty.ts'), 'developer A + agent B');
    fs.writeFileSync(path.join(dir, 'created.ts'), 'new');
    fs.writeFileSync(path.join(dir, 'preexisting.tmp'), 'pipeline touched it');
    const baseline = snap('baseline', { 'dirty.ts': 'developer A', 'deleted.ts': 'keep', 'preexisting.tmp': 'developer untracked' });
    const current = snap('current', { 'dirty.ts': 'developer A + agent B', 'created.ts': 'new', 'preexisting.tmp': 'pipeline touched it' });
    const service = new GitSafetyService(commands);
    jest.spyOn(service, 'capture').mockResolvedValueOnce(current).mockResolvedValueOnce(baseline);
    const result = await service.rollback(dir, baseline);
    expect(result.verified).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'dirty.ts'), 'utf8')).toBe('developer A');
    expect(fs.readFileSync(path.join(dir, 'deleted.ts'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(dir, 'preexisting.tmp'), 'utf8')).toBe('developer untracked');
    expect(fs.existsSync(path.join(dir, 'created.ts'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports rollback verification failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-git-safety-fail-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'agent');
    const baseline = snap('baseline', { 'a.ts': 'developer' });
    const current = snap('current', { 'a.ts': 'agent' });
    const stillDifferent = snap('different', { 'a.ts': 'other' });
    const service = new GitSafetyService(commands);
    jest.spyOn(service, 'capture').mockResolvedValueOnce(current).mockResolvedValueOnce(stillDifferent);
    await expect(service.rollback(dir, baseline)).resolves.toMatchObject({ verified: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
