import { Logger } from '@nestjs/common';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CommandRequest } from '@amp/core';
import { OpenCodeAgentProvider, parseApplyResult } from './opencode-agent.provider';
import { CommandExecutionService } from '../execution/command-execution.service';
import { ProposeFixPromptBuilder } from './propose-fix-prompt.builder';
import { ApplyFixPromptBuilder } from './apply-fix-prompt.builder';
import { WorkingTreeGuardService } from './working-tree-guard.service';

describe('OpenCode execution diagnostics', () => {
  it('selects the valid apply result from OpenCode JSON events', () => {
    const response = JSON.stringify({ summary: 'Applied fix', warnings: ['review'] });
    const stdout = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses-1' }),
      JSON.stringify({ type: 'text', part: { text: response, metadata: '{}' } }),
      JSON.stringify({ type: 'step_finish', result: {} }),
    ].join('\n');
    expect(parseApplyResult(stdout)).toEqual({ summary: 'Applied fix', warnings: ['review'] });
  });

  it('accepts a fenced JSON apply result nested in an event', () => {
    const stdout = JSON.stringify({ type: 'text', part: { text: '```json\n{"summary":"ok","warnings":[]}\n```' } });
    expect(parseApplyResult(stdout)).toEqual({ summary: 'ok', warnings: [] });
  });

  it('accepts an apply result without warnings', () => {
    const stdout = JSON.stringify({
      type: 'text',
      part: { text: '{"summary":"Applied the approved change"}' },
    });
    expect(parseApplyResult(stdout)).toEqual({
      summary: 'Applied the approved change',
      warnings: [],
    });
  });

  it('accepts nested result aliases and a single warning', () => {
    const stdout = JSON.stringify({
      type: 'text',
      part: { text: '{"result":{"message":"Applied fix","warning":"Review naming"}}' },
    });
    expect(parseApplyResult(stdout)).toEqual({
      summary: 'Applied fix',
      warnings: ['Review naming'],
    });
  });

  it('uses the final OpenCode assistant text as a summary', () => {
    const stdout = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses-1' }),
      JSON.stringify({ type: 'text', part: { text: 'Applied the approved refactor successfully.' } }),
      JSON.stringify({ type: 'step_finish', result: {} }),
    ].join('\n');
    expect(parseApplyResult(stdout)).toEqual({
      summary: 'Applied the approved refactor successfully.',
      warnings: [],
    });
  });

  it('logs the sanitized prompt and progress, kills the process tree and removes the attachment', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amp-opencode-spec-'));
    const saved = process.env.TEST_SECRET;
    process.env.TEST_SECRET = 'fixture-sensitive-value';
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let attachment = '';
    const execute = jest.fn(async (request: CommandRequest) => {
      attachment = request.args!.find(arg => arg.startsWith('--file='))!.slice(7);
      expect(await fs.readFile(attachment, 'utf8')).toContain('test instructions');
      expect(request.killProcessTree).toBe(true);
      expect(request.args).toContain('--print-logs');
      request.onOutput!({ stream: 'stderr', text: 'waiting fixture-sensitive-value\n' });
      return { success: false, timedOut: true, stdout: '', stderr: '', exitCode: null, durationMs: 120000 };
    });
    const provider = new OpenCodeAgentProvider(
      { execute } as unknown as CommandExecutionService,
      {} as ProposeFixPromptBuilder, {} as ApplyFixPromptBuilder, {} as WorkingTreeGuardService,
    );
    try {
      const result = await provider['runWithPromptAttachment'](directory, 'opencode', directory, 120000,
        'test instructions fixture-sensitive-value', true, 'read attachment', 'task-test');
      expect(result.timedOut).toBe(true);
      const output = JSON.stringify(logs.mock.calls);
      expect(output).toContain('promptPreview');
      expect(output).toContain('task-test');
      expect(output).toContain('completed');
      expect(output).not.toContain('fixture-sensitive-value');
      await expect(fs.access(attachment)).rejects.toThrow();
    } finally {
      if (saved === undefined) delete process.env.TEST_SECRET;
      else process.env.TEST_SECRET = saved;
      logs.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
