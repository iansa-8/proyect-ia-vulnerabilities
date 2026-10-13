import type { CommandResult, AgentTask } from '@amp/core';
import type { CommandExecutionService } from '../execution/command-execution.service';
import { CodexAgentProvider } from './codex-agent.provider';
import { ProposeFixPromptBuilder } from './propose-fix-prompt.builder';
import { ApplyFixPromptBuilder } from './apply-fix-prompt.builder';
import type { WorkingTreeGuardService, WorkingTreeSnapshot } from './working-tree-guard.service';

const snapshot: WorkingTreeSnapshot = {
  fingerprint: 'same',
  status: '',
  trackedDiff: '',
  stagedDiff: '',
  untracked: {},
};

function command(overrides: Partial<CommandResult> = {}): CommandResult {
  const now = new Date();
  return {
    command: 'codex',
    args: [],
    cwd: 'C:\\repo',
    exitCode: 0,
    stdout: '',
    stderr: '',
    startedAt: now,
    finishedAt: now,
    durationMs: 1,
    timedOut: false,
    success: true,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

function task(type: AgentTask['type'] = 'propose-fix'): AgentTask {
  return {
    id: 'task-1',
    type,
    projectPath: 'C:\\repo',
    project: { id: 'project-1', path: 'C:\\repo', runtime: 'node', framework: 'nestjs' },
    issue: { provider: 'sonar', id: 'issue-1', message: 'Reduce complexity', file: 'src/a.ts', line: 10 },
    context: {
      indexProvider: 'codebase-memory',
      indexState: 'fresh',
      targetSymbol: 'A.run',
      files: ['src/a.ts'],
      symbols: ['A.run'],
      snippets: [{ file: 'src/a.ts', content: 'run() {}' }],
    },
    constraints: ['preserve architecture'],
    validationCommands: { build: 'npm run build' },
  };
}

function setup(execResults: CommandResult[], captures = [snapshot, snapshot]) {
  const execute = jest.fn();
  for (const result of execResults) execute.mockResolvedValueOnce(result);
  const commands = { execute } as unknown as CommandExecutionService;
  const guard = {
    capture: jest.fn()
      .mockResolvedValueOnce(captures[0])
      .mockResolvedValueOnce(captures[1]),
    unchanged: jest.fn((a: WorkingTreeSnapshot, b: WorkingTreeSnapshot) => a.fingerprint === b.fingerprint),
  } as unknown as WorkingTreeGuardService;
  return { provider: new CodexAgentProvider(commands, new ProposeFixPromptBuilder(), new ApplyFixPromptBuilder(), guard), execute };
}

describe('CodexAgentProvider', () => {
  const proposal = {
    summary: 'Extract validation branches.',
    diagnosis: 'The method has excessive cognitive complexity.',
    proposedChanges: [{ file: 'src/a.ts', description: 'Extract helpers.' }],
    affectedFiles: ['src/a.ts'],
    risk: 'medium',
    validationPlan: ['npm run build'],
    assumptions: [],
    warnings: [],
  };
  const jsonl = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(proposal) } });

  it('reports Codex as application-only', async () => {
    const { provider } = setup([command({ stdout: 'codex-cli 0.155.0-alpha.16\n' })]);
    await expect(provider.health()).resolves.toEqual({
      available: true,
      provider: 'codex',
      version: '0.155.0-alpha.16',
      capabilities: ['apply-fix'],
      error: undefined,
    });
  });

  it('applies only an approved proposal in workspace-write mode', async () => {
    const applyJsonl = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ summary: 'Applied approved extraction.', warnings: [] }) } });
    const { provider, execute } = setup([
      command({ stdout: 'codex-cli 0.155.0-alpha.16\n' }),
      command({ stdout: applyJsonl }),
    ]);
    const input = task('apply-fix');
    input.proposalId = 'proposal-1';
    input.approvedProposal = { ...proposal, provider: 'codex', taskId: 'proposal-task', agentSuggestedRisk: 'medium' };
    input.allowedFiles = ['src/a.ts'];
    const result = await provider.applyFix(input);
    expect(result).toMatchObject({ success: true, summary: 'Applied approved extraction.', provider: 'codex' });
    expect(execute.mock.calls[1][0].args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(execute.mock.calls[1][0].stdin).toContain('proposal-1');
    expect(execute.mock.calls[1][0].stdin).toContain('src/a.ts');
  });

  it('normalizes apply timeout', async () => {
    const { provider } = setup([
      command({ stdout: 'codex-cli 0.155.0-alpha.16\n' }),
      command({ timedOut: true, success: false }),
    ]);
    const input = task('apply-fix');
    input.proposalId = 'proposal-1';
    input.approvedProposal = { ...proposal, provider: 'codex', taskId: 'proposal-task', agentSuggestedRisk: 'medium' };
    input.allowedFiles = ['src/a.ts'];
    await expect(provider.applyFix(input)).resolves.toMatchObject({ success: false, error: { code: 'AGENT_TIMEOUT' } });
  });

  it('reports unavailable without throwing', async () => {
    const { provider } = setup([command({ success: false, exitCode: null })]);
    await expect(provider.health()).resolves.toMatchObject({ available: false, provider: 'codex' });
  });

  it('returns a validated proposal and passes the prompt through stdin', async () => {
    const { provider, execute } = setup([
      command({ stdout: 'codex-cli 0.155.0-alpha.16\n' }),
      command({ stdout: jsonl }),
    ]);
    const result = await provider.proposeFix(task());
    expect(result.success).toBe(true);
    expect(result.proposal).toMatchObject({ taskId: 'task-1', agentSuggestedRisk: 'medium' });
    expect(result.touchedFiles).toEqual([]);
    expect(execute.mock.calls[1][0].args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--ephemeral', '--output-schema']));
    expect(execute.mock.calls[1][0].stdin).toContain('Do not modify');
    expect(execute.mock.calls[1][0].args.join(' ')).not.toContain('Reduce complexity');
    expect(result.executionTrace).toMatchObject({
      indexProvider: 'codebase-memory',
      indexState: 'fresh',
      targetSymbol: 'A.run',
      filesIncluded: ['src/a.ts'],
      symbolsIncluded: 1,
      snippetsIncluded: 1,
      snippetChars: 8,
      promptPreviewTruncated: false,
    });
    expect(result.executionTrace?.promptPreview).toBe(execute.mock.calls[1][0].stdin);
    expect(result.executionTrace?.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.executionTrace?.promptChars).toBe(execute.mock.calls[1][0].stdin.length);
  });

  it.each([
    ['timeout', command({ timedOut: true, success: false }), 'AGENT_TIMEOUT'],
    ['non-zero exit', command({ success: false, exitCode: 2, stderr: 'failed' }), 'AGENT_EXECUTION_FAILED'],
    ['empty response', command({ stdout: '' }), 'INVALID_AGENT_RESPONSE'],
    ['invalid JSON', command({ stdout: '{"bad":true}' }), 'INVALID_AGENT_RESPONSE'],
  ])('normalizes %s', async (_name, execution, code) => {
    const { provider } = setup([
      command({ stdout: 'codex-cli 0.155.0-alpha.16\n' }),
      execution,
    ]);
    await expect(provider.proposeFix(task())).resolves.toMatchObject({ success: false, error: { code } });
  });

  it('rejects unsupported capabilities without invoking Codex', async () => {
    const { provider, execute } = setup([]);
    await expect(provider.execute(task('analyze'))).resolves.toMatchObject({
      success: false,
      error: { code: 'UNSUPPORTED_CAPABILITY' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('detects repository writes and never reports success', async () => {
    const changed = { ...snapshot, fingerprint: 'changed', status: '?? new.ts' };
    const { provider } = setup([
      command({ stdout: 'codex-cli 0.155.0-alpha.16\n' }),
      command({ stdout: jsonl }),
    ], [snapshot, changed]);
    await expect(provider.proposeFix(task())).resolves.toMatchObject({
      success: false,
      error: { code: 'AGENT_WRITE_DETECTED' },
      writeDetection: { unchanged: false },
    });
  });

  it('redacts secret values from normalized execution errors', async () => {
    const previous = process.env.CODEX_API_TOKEN;
    process.env.CODEX_API_TOKEN = 'do-not-leak';
    try {
      const { provider } = setup([
        command({ stdout: 'codex-cli 0.155.0-alpha.16\n' }),
        command({ success: false, exitCode: 1, stderr: 'failure do-not-leak' }),
      ]);
      const result = await provider.proposeFix(task());
      expect(result.error?.message).toContain('[REDACTED]');
      expect(result.error?.message).not.toContain('do-not-leak');
      expect(result.executionTrace?.promptPreview).not.toContain('do-not-leak');
    } finally {
      if (previous === undefined) delete process.env.CODEX_API_TOKEN;
      else process.env.CODEX_API_TOKEN = previous;
    }
  });

  it('extracts the real failure from Codex JSONL stdout', async () => {
    const jsonError = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'invalid_json_schema: rationale is required' },
    });
    const { provider } = setup([
      command({ stdout: 'codex-cli 0.155.0-alpha.16\n' }),
      command({
        success: false,
        exitCode: 1,
        stdout: jsonError,
        stderr: 'non-actionable warning',
      }),
    ]);
    await expect(provider.proposeFix(task())).resolves.toMatchObject({
      success: false,
      error: {
        code: 'AGENT_EXECUTION_FAILED',
        message: 'invalid_json_schema: rationale is required',
      },
    });
  });
});

describe('ProposeFixPromptBuilder', () => {
  it('includes minimal bounded context and constraints while redacting secrets', () => {
    const previous = process.env.TEST_API_TOKEN;
    process.env.TEST_API_TOKEN = 'super-secret-value';
    try {
      const input = task();
      input.context = {
        files: ['src/a.ts'],
        snippets: [{ file: 'src/a.ts', content: 'const token = "super-secret-value";' }],
      };
      const prompt = new ProposeFixPromptBuilder().build(input);
      expect(prompt).toContain('"issue"');
      expect(prompt).toContain('src/a.ts');
      expect(prompt).toContain('preserve architecture');
      expect(prompt).not.toContain('npm run build');
      expect(prompt).toContain('Do not modify');
      expect(prompt).not.toContain('super-secret-value');
      expect(prompt).toContain('[REDACTED]');
      expect(prompt).not.toContain('C:\\repo');
    } finally {
      if (previous === undefined) delete process.env.TEST_API_TOKEN;
      else process.env.TEST_API_TOKEN = previous;
    }
  });
});
