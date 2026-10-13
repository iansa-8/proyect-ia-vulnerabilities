import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandResult } from '@amp/core';
import type { CommandExecutionService } from '../execution/command-execution.service';
import { WorkingTreeGuardService } from './working-tree-guard.service';
import { GitSafetyService } from './git-safety.service';

function result(stdout: string): CommandResult {
  const now = new Date();
  return { command: 'git', args: [], cwd: '', exitCode: 0, stdout, stderr: '', startedAt: now, finishedAt: now, durationMs: 1, timedOut: false, success: true, stdoutTruncated: false, stderrTruncated: false };
}
function mockCommands(outputs: string[]) {
  const execute = jest.fn();
  for (const output of outputs) execute.mockResolvedValueOnce(result(output));
  return { execute } as unknown as CommandExecutionService;
}

describe('WorkingTreeGuardService', () => {
  it.each([
    ['clean', ['', '', '', ''], ['', '', '', ''], true],
    ['initially dirty but unchanged', [' M a.ts', 'diff-a', '', ''], [' M a.ts', 'diff-a', '', ''], true],
    ['tracked file changed', [' M a.ts', 'diff-a', '', ''], [' M a.ts', 'diff-b', '', ''], false],
    ['new file appears', ['', '', '', ''], ['?? new.ts', '', '', 'new.ts\0'], false],
  ])('%s', async (_name, beforeState, afterState, unchanged) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-agent-guard-'));
    if (afterState[3]) fs.writeFileSync(path.join(dir, 'new.ts'), 'new');
    const outputs = [
      'true\n', ...beforeState,
      'true\n', ...afterState,
    ];
    const guard = new WorkingTreeGuardService(new GitSafetyService(mockCommands(outputs)));
    const before = await guard.capture(dir);
    const after = await guard.capture(dir);
    expect(guard.unchanged(before, after)).toBe(unchanged);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
