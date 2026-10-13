import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StructuredPatch } from '@amp/core';
import { StructuredPatchEngine } from './structured-patch.engine';
import { PatchValidator } from './patch-validator.service';

describe('StructuredPatchEngine', () => {
  let root: string;
  let validator: PatchValidator;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-patch-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    validator = new PatchValidator();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('applies a reviewed line edit and preserves line endings', () => {
    const file = path.join(root, 'src', 'a.ts');
    fs.writeFileSync(file, 'private hola: string;\r\nuse(hola);\r\n');
    const patch: StructuredPatch = {
      version: 1,
      edits: [{
        file: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        expectedText: 'private hola: string;',
        replacement: 'private readonly hola: string;',
      }],
      preconditions: [{ file: 'src/a.ts', forbiddenPatterns: ['\\bhola\\s*='] }],
    };

    const result = new StructuredPatchEngine(validator).apply(root, patch);

    expect(result).toMatchObject({ success: true, changedFiles: ['src/a.ts'], editCount: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe('private readonly hola: string;\r\nuse(hola);\r\n');
  });

  it('applies an exact multiline replacement', () => {
    const file = path.join(root, 'src', 'a.ts');
    fs.writeFileSync(file, 'one\ntwo\nthree\n', 'utf8');
    const patch: StructuredPatch = {
      version: 1,
      edits: [{
        file: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        expectedText: 'one\ntwo',
        replacement: 'first\nsecond',
      }],
      preconditions: [],
    };

    const result = new StructuredPatchEngine(validator).apply(root, patch);

    expect(result).toMatchObject({ success: true, changedFiles: ['src/a.ts'] });
    expect(fs.readFileSync(file, 'utf8')).toBe('first\nsecond\nthree\n');
  });

  it('does not write when a precondition detects a reassignment', () => {
    const file = path.join(root, 'src', 'a.ts');
    const original = 'private hola: string;\nthis.hola = value;\n';
    fs.writeFileSync(file, original);
    const patch: StructuredPatch = {
      version: 1,
      edits: [{
        file: 'src/a.ts', startLine: 1, endLine: 1,
        expectedText: 'private hola: string;', replacement: 'private readonly hola: string;',
      }],
      preconditions: [{ file: 'src/a.ts', forbiddenPatterns: ['\\bthis\\.hola\\s*='] }],
    };

    const result = new StructuredPatchEngine(validator).apply(root, patch);

    expect(result).toMatchObject({ success: false, error: 'PATCH_PRECONDITION_FAILED' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('rejects stale expected text without modifying the file', () => {
    const file = path.join(root, 'src', 'a.ts');
    const original = 'private other: string;\n';
    fs.writeFileSync(file, original);
    const patch: StructuredPatch = {
      version: 1,
      edits: [{
        file: 'src/a.ts', startLine: 1, endLine: 1,
        expectedText: 'private hola: string;', replacement: 'private readonly hola: string;',
      }],
      preconditions: [],
    };

    const result = new StructuredPatchEngine(validator).apply(root, patch);

    expect(result).toMatchObject({ success: false, error: 'PATCH_EXPECTED_TEXT_MISMATCH' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('reanchors a unique exact block when its declared line is slightly stale', () => {
    const file = path.join(root, 'src', 'a.ts');
    fs.writeFileSync(file, 'header\nold\nvalue\nfooter\n');
    const patch: StructuredPatch = {
      version: 1,
      edits: [{
        file: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        expectedText: 'old\nvalue',
        replacement: 'new',
      }],
      preconditions: [],
    };

    expect(new StructuredPatchEngine(validator).apply(root, patch)).toMatchObject({
      success: true,
      changedFiles: ['src/a.ts'],
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('header\nnew\nfooter\n');
  });

  it('fails closed for mixed line endings instead of rewriting the whole file', () => {
    const file = path.join(root, 'src', 'a.ts');
    fs.writeFileSync(file, 'private hola: string;\r\nuse(hola);\n');
    const patch: StructuredPatch = {
      version: 1,
      edits: [{
        file: 'src/a.ts', startLine: 1, endLine: 1,
        expectedText: 'private hola: string;', replacement: 'private readonly hola: string;',
      }],
      preconditions: [],
    };

    expect(new StructuredPatchEngine(validator).apply(root, patch)).toMatchObject({
      success: false,
      error: 'PATCH_MIXED_LINE_ENDINGS',
    });
  });

  it('rejects paths outside the project', () => {
    const patch: StructuredPatch = {
      version: 1,
      edits: [{
        file: '../outside.ts', startLine: 1, endLine: 1,
        expectedText: 'x', replacement: 'y',
      }],
      preconditions: [],
    };

    expect(new StructuredPatchEngine(validator).apply(root, patch)).toMatchObject({
      success: false,
      error: 'PATCH_INVALID_PATH',
    });
  });
});
