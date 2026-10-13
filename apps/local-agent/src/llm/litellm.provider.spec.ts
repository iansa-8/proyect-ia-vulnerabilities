import type { AgentTask } from '@amp/core';
import { ProposeFixPromptBuilder } from '../agent/propose-fix-prompt.builder';
import { BulkProposeFixPromptBuilder } from '../agent/bulk-propose-fix-prompt.builder';
import { LiteLLMProvider } from './litellm.provider';

const task: AgentTask = {
  id: 'task-1', type: 'propose-fix', projectPath: 'C:\\repo',
  project: { id: 'internal-project-id', path: 'C:\\repo', runtime: 'node', framework: 'nest' },
  issue: { id: 'internal-issue-id', provider: 'sonar', rule: 'typescript:S3776', severity: 'CRITICAL', message: 'Reduce complexity', file: 'src/a.ts', line: 4 },
  context: { indexProvider: 'codebase-memory', targetSymbol: 'A.run', files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', content: 'run() {}' }] },
  constraints: ['preserve behavior'], validationCommands: { build: 'npm run build' },
};

describe('LiteLLMProvider', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000';
    process.env.LITELLM_API_KEY = 'secret-litellm-key';
    process.env.LITELLM_MODEL = 'small-model';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_API_KEY;
    delete process.env.LITELLM_MODEL;
  });

  it('calls the OpenAI-compatible endpoint and returns structured usage', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: 'small-model',
        choices: [{ message: { content: JSON.stringify({ summary: 'Extract helper', proposedChanges: [{ file: 'src/a.ts', description: 'Extract a helper' }], risk: 'medium', confidence: 0.8, warnings: [] }) } }],
        usage: { prompt_tokens: 180, completion_tokens: 42, total_tokens: 222 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new LiteLLMProvider(new ProposeFixPromptBuilder());
    await expect(provider.health()).resolves.toMatchObject({ available: true, model: 'small-model' });
    const result = await provider.proposeFix(task);
    expect(result).toMatchObject({ success: true, provider: 'litellm', usage: { inputTokens: 180, outputTokens: 42 }, proposal: { remediationStrategy: 'llm' } });
    const request = (global.fetch as jest.Mock).mock.calls[1];
    expect(request[0]).toBe('http://localhost:4000/v1/chat/completions');
    expect(request[1].headers.Authorization).toBe('Bearer secret-litellm-key');
    expect(request[1].body).not.toContain('internal-project-id');
    expect(request[1].body).not.toContain('internal-issue-id');
  });

  it('preserves a validated structured patch for platform application', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'small-model',
      choices: [{ message: { content: JSON.stringify({
        summary: 'Extract helper',
        proposedChanges: [{ file: 'src/a.ts', description: 'Extract a helper' }],
        risk: 'medium',
        patch: {
          version: 1,
          edits: [{ file: 'src/a.ts', startLine: 1, endLine: 1, expectedText: 'before', replacement: 'after' }],
          preconditions: [{ file: 'src/a.ts', forbiddenPatterns: ['\\bunsafe\\s*='] }],
        },
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder()).proposeFix(task);

    expect(result).toMatchObject({ success: true, proposal: { patch: { version: 1, edits: [{ file: 'src/a.ts' }] } } });
  });

  it('accepts a fenced JSON proposal with a multiline exact patch', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: `\`\`\`json
${JSON.stringify({
  summary: 'Extract helper',
  proposedChanges: [{ file: 'src/a.ts', description: 'Extract a helper' }],
  risk: 'medium',
  patch: {
    version: 1,
    edits: [{ file: 'src/a.ts', startLine: 1, endLine: 2, expectedText: 'before\nafter', replacement: 'next\nvalue' }],
    preconditions: [],
  },
})}
\`\`\`` } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder()).proposeFix(task);

    expect(result).toMatchObject({ success: true, proposal: { patch: { edits: [{ expectedText: 'before\nafter' }] } } });
  });

  it('normalizes common DeepSeek proposal aliases without weakening file validation', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: `Proposal:\n${JSON.stringify({
        proposal: {
          title: 'Remove redundant implementation',
          proposed_changes: [{ path: 'src/a.ts', change: 'Remove the empty method body' }],
          risk: 'LOW',
          confidence: '0.9',
          warnings: null,
          requires_agent: false,
        },
      })}` } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder()).proposeFix(task);

    expect(result).toMatchObject({
      success: true,
      proposal: {
        summary: 'Remove redundant implementation',
        proposedChanges: [{ file: 'src/a.ts', description: 'Remove the empty method body' }],
        agentSuggestedRisk: 'low',
        requiresAgent: false,
      },
    });
  });

  it('reports output-limit responses without classifying them as malformed JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '{' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder()).proposeFix(task);

    expect(result).toMatchObject({ success: false, error: { code: 'LLM_OUTPUT_TRUNCATED' } });
  });

  it('rejects malformed patch responses as invalid model output', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: 'Unsafe patch',
        proposedChanges: [{ file: '../outside.ts', description: 'edit' }],
        risk: 'low',
        patch: { version: 1, edits: [], preconditions: [] },
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder()).proposeFix(task);

    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_LLM_RESPONSE' } });
  });

  it('redacts the API key from provider errors', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('bad secret-litellm-key', { status: 401 }));
    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder()).proposeFix(task);
    expect(result.error?.message).toContain('[REDACTED]');
    expect(result.error?.message).not.toContain('secret-litellm-key');
  });

  it('reports unavailable without exposing credentials when configuration is incomplete', async () => {
    delete process.env.LITELLM_API_KEY;
    await expect(new LiteLLMProvider(new ProposeFixPromptBuilder()).health()).resolves.toMatchObject({ available: false, provider: 'litellm' });
    expect(global.fetch).toBe(originalFetch);
  });

  it('returns one validated proposal per issue from a shared batch prompt', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'small-model',
      choices: [{ message: { content: JSON.stringify({ proposals: [
        { issueId: 'issue-1', summary: 'Fix first', proposedChanges: [{ file: 'src/a.ts', description: 'First change' }], risk: 'low', warnings: [] },
        { issueId: 'issue-2', summary: 'Fix second', proposedChanges: [{ file: 'src/a.ts', description: 'Second change' }], risk: 'low', warnings: [] },
      ] }) } }],
      usage: { prompt_tokens: 240, completion_tokens: 80, total_tokens: 320 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const context = { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', content: 'class A {}' }] };
    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder(), new BulkProposeFixPromptBuilder()).proposeFixBatch({
      project: { runtime: 'node' }, constraints: ['preserve behavior'], items: [
        { issue: { id: 'issue-1', provider: 'sonar', message: 'First', file: 'src/a.ts' }, context },
        { issue: { id: 'issue-2', provider: 'sonar', message: 'Second', file: 'src/a.ts' }, context },
      ],
    });

    expect(result).toMatchObject({ success: true, inputTokens: 240, proposals: [{ issueId: 'issue-1' }, { issueId: 'issue-2' }] });
    expect(result.prompt.match(/class A \{\}/g)).toHaveLength(1);
  });

  it('accepts a single-proposal response without a batch envelope', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: 'Remove the assignment',
        proposed_changes: [{ path: 'src/a.ts', change: 'Remove the unused assignment' }],
        risk: 'LOW',
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder(), new BulkProposeFixPromptBuilder()).proposeFixBatch({
      project: { runtime: 'node' }, constraints: [], items: [{
        issue: { id: 'issue-1', provider: 'sonar', message: 'Unused assignment', file: 'src/a.ts' },
        context: { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', content: 'const unused = value;' }] },
      }],
    });
    expect(result).toMatchObject({ success: true, proposals: [{ issueId: 'issue-1', proposal: { agentSuggestedRisk: 'low' } }] });
  });

  it('preserves token usage when a batch response is truncated', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'small-model',
      choices: [{ finish_reason: 'length', message: { content: '{"proposals":[' } }],
      usage: { prompt_tokens: 900, completion_tokens: 1200, total_tokens: 2100 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder(), new BulkProposeFixPromptBuilder()).proposeFixBatch({
      project: { runtime: 'node' }, constraints: [], items: [{
        issue: { id: 'issue-1', provider: 'sonar', message: 'Complex issue', file: 'src/a.ts' },
        context: { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', content: 'class A {}' }] },
      }],
    });
    expect(result).toMatchObject({
      success: false,
      inputTokens: 900,
      outputTokens: 1200,
      error: { code: 'LLM_OUTPUT_TRUNCATED' },
    });
  });

  it('keeps a valid proposal and safely discards an invalid optional patch', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        proposals: [{
          issueId: 'issue-1', summary: 'Remove redundant assignment',
          proposedChanges: [{ file: 'src/a.ts', description: 'Remove the assignment' }],
          risk: 'low', patch: { version: 1, edits: [], preconditions: [] },
        }],
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder(), new BulkProposeFixPromptBuilder()).proposeFixBatch({
      project: { runtime: 'node' }, constraints: [], items: [{
        issue: { id: 'issue-1', provider: 'sonar', message: 'Unused assignment', file: 'src/a.ts' },
        context: { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', content: 'const unused = value;' }] },
      }],
    });
    expect(result).toMatchObject({
      success: true,
      proposals: [{ proposal: { requiresAgent: true, patch: undefined } }],
    });
    expect(result.proposals[0].proposal.warnings?.join(' ')).toContain('patch no aplicable');
  });

  it('repairs trailing commas and literal newlines in otherwise valid batch JSON', async () => {
    const content = '{"proposals":[{"issueId":"issue-1","summary":"First line\nsecond line","proposedChanges":[{"file":"src/a.ts","description":"Remove assignment",}],"risk":"low",}],}';
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder(), new BulkProposeFixPromptBuilder()).proposeFixBatch({
      project: { runtime: 'node' }, constraints: [], items: [{
        issue: { id: 'issue-1', provider: 'sonar', message: 'Unused assignment', file: 'src/a.ts' },
        context: { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', content: 'const unused = value;' }] },
      }],
    });
    expect(result).toMatchObject({ success: true, proposals: [{ issueId: 'issue-1' }] });
  });

  it('uses one compact repair call after an irreparable model JSON response', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: 'small-model',
        choices: [{ message: { content: '{not valid json' } }],
        usage: { prompt_tokens: 1_100, completion_tokens: 190, total_tokens: 1_290 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: 'small-model',
        choices: [{ message: { content: JSON.stringify({ proposals: [{
          issueId: 'issue-1', summary: 'Extract validation helpers',
          proposedChanges: [{ file: 'src/a.ts', description: 'Extract pagination validation helpers' }],
          risk: 'medium', requiresAgent: true,
        }] }) } }],
        usage: { prompt_tokens: 90, completion_tokens: 80, total_tokens: 170 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await new LiteLLMProvider(new ProposeFixPromptBuilder(), new BulkProposeFixPromptBuilder()).proposeFixBatch({
      project: { runtime: 'node' }, constraints: [], items: [{
        issue: { id: 'issue-1', provider: 'sonar', rule: 'typescript:S3776', message: 'Reduce complexity', file: 'src/a.ts' },
        context: { files: ['src/a.ts'], snippets: [{ file: 'src/a.ts', content: 'function complex() {}' }] },
      }],
    });
    expect(result).toMatchObject({
      success: true, attempts: 2, inputTokens: 1_190, outputTokens: 270,
      proposals: [{ issueId: 'issue-1' }],
    });
    expect(result.recoveryPrompt).toContain('{not valid json');
    expect((global.fetch as jest.Mock).mock.calls[1][1].body).not.toContain('function complex() {}');
  });
});
