import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandExecutionService } from '../execution/command-execution.service';
import { GitSafetyService } from './git-safety.service';

describe('GitSafetyService real rollback fixture', () => {
  it('restores the exact dirty baseline without reset, clean, or checkout', async () => {
    const parent = path.join(os.tmpdir(), 'amp-git-safety-tests');
    fs.mkdirSync(parent, { recursive: true });
    const repo = fs.mkdtempSync(path.join(parent, 'rollback-'));
    const previousRoots = process.env.ALLOWED_PROJECT_ROOTS;
    process.env.ALLOWED_PROJECT_ROOTS = parent;
    const commands = new CommandExecutionService();
    const run = async (args: string[]) => {
      const result = await commands.execute({ command: 'git', args, cwd: repo, timeoutMs: 30_000 });
      if (!result.success) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    };
    try {
      await run(['init']);
      await run(['config', 'user.email', 'fixture@example.invalid']);
      await run(['config', 'user.name', 'Fixture']);
      fs.writeFileSync(path.join(repo, 'dirty.ts'), 'committed\n');
      fs.writeFileSync(path.join(repo, 'deleted.ts'), 'recover me\n');
      await run(['add', 'dirty.ts', 'deleted.ts']);
      await run(['commit', '-m', 'fixture']);

      fs.writeFileSync(path.join(repo, 'dirty.ts'), 'developer change A\n');
      fs.writeFileSync(path.join(repo, 'preexisting.tmp'), 'developer untracked\n');
      const safety = new GitSafetyService(commands);
      const baseline = await safety.capture(repo);

      fs.writeFileSync(path.join(repo, 'dirty.ts'), 'developer change A\nagent change B\n');
      fs.writeFileSync(path.join(repo, 'created.ts'), 'pipeline file\n');
      fs.writeFileSync(path.join(repo, 'preexisting.tmp'), 'pipeline touched existing untracked\n');
      fs.rmSync(path.join(repo, 'deleted.ts'));

      const delta = safety.compare(baseline, await safety.capture(repo));
      expect(delta.changedFiles).toEqual(expect.arrayContaining(['dirty.ts', 'created.ts', 'preexisting.tmp', 'deleted.ts']));
      const rollback = await safety.rollback(repo, baseline);
      expect(rollback.verified).toBe(true);
      expect(fs.readFileSync(path.join(repo, 'dirty.ts'), 'utf8')).toBe('developer change A\n');
      expect(fs.readFileSync(path.join(repo, 'preexisting.tmp'), 'utf8')).toBe('developer untracked\n');
      expect(fs.readFileSync(path.join(repo, 'deleted.ts'), 'utf8')).toBe('recover me\n');
      expect(fs.existsSync(path.join(repo, 'created.ts'))).toBe(false);
    } finally {
      if (previousRoots === undefined) delete process.env.ALLOWED_PROJECT_ROOTS;
      else process.env.ALLOWED_PROJECT_ROOTS = previousRoots;
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
