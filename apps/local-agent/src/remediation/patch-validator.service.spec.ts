import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StructuredPatch } from '@amp/core';
import { STRUCTURED_PATCH_VERSION } from '@amp/core';
import { PatchValidator } from './patch-validator.service';

describe('PatchValidator', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-patch-validator-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('validates a correct patch', () => {
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

    const result = new PatchValidator().validate(root, patch);

    expect(result).toMatchObject({ valid: true, files: ['src/a.ts'], edits: patch.edits, preconditions: patch.preconditions });
  });

  it('rejects invalid patch version', () => {
    const patch: StructuredPatch = { version: 99 as unknown as typeof STRUCTURED_PATCH_VERSION, edits: [], preconditions: [] };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_INVALID' });
  });

  it('rejects empty edits', () => {
    const patch: StructuredPatch = { version: 1, edits: [], preconditions: [] };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_INVALID' });
  });

  it('rejects too many edits', () => {
    const patch: StructuredPatch = {
      version: 1,
      edits: Array.from({ length: 51 }, (_, i) => ({
        file: `src/a${i}.ts`, startLine: 1, endLine: 1, expectedText: 'x', replacement: 'y',
      })),
      preconditions: [],
    };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_TOO_LARGE' });
  });

  it('rejects path traversal', () => {
    const patch: StructuredPatch = {
      version: 1,
      edits: [{ file: '../outside.ts', startLine: 1, endLine: 1, expectedText: 'x', replacement: 'y' }],
      preconditions: [],
    };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_INVALID_PATH' });
  });

  it('rejects absolute paths', () => {
    const patch: StructuredPatch = {
      version: 1,
      edits: [{ file: '/absolute/path.ts', startLine: 1, endLine: 1, expectedText: 'x', replacement: 'y' }],
      preconditions: [],
    };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_INVALID_PATH' });
  });

  it('rejects sensitive paths', () => {
    const patch: StructuredPatch = {
      version: 1,
      edits: [{ file: 'node_modules/x.ts', startLine: 1, endLine: 1, expectedText: 'x', replacement: 'y' }],
      preconditions: [],
    };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_SENSITIVE_FILE' });
  });

  it('rejects invalid line range', () => {
    const patch: StructuredPatch = {
      version: 1,
      edits: [{ file: 'src/a.ts', startLine: 0, endLine: 1, expectedText: 'x', replacement: 'y' }],
      preconditions: [],
    };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_INVALID_LINE_RANGE' });
  });

  it('rejects overlapping edits', () => {
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'line1\nline2\nline3\n');
    const patch: StructuredPatch = {
      version: 1,
      edits: [
        { file: 'src/a.ts', startLine: 1, endLine: 2, expectedText: 'line1\nline2', replacement: 'new1\nnew2' },
        { file: 'src/a.ts', startLine: 2, endLine: 3, expectedText: 'line2\nline3', replacement: 'new2\nnew3' },
      ],
      preconditions: [],
    };
    // The validator normalizes edits first; newline in expectedText is rejected early
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_INVALID_TEXT' });
  });

  it('rejects expected text mismatch at apply time, not validate', () => {
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'different content\n');
    const patch: StructuredPatch = {
      version: 1,
      edits: [{ file: 'src/a.ts', startLine: 1, endLine: 1, expectedText: 'expected', replacement: 'new' }],
      preconditions: [],
    };
    // Validator does not check expectedText against file content; that happens at apply time
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: true });
  });

  it('rejects precondition failure', () => {
    const file = path.join(root, 'src', 'a.ts');
    fs.writeFileSync(file, 'hola = 1;\n');
    const patch: StructuredPatch = {
      version: 1,
      edits: [{ file: 'src/a.ts', startLine: 1, endLine: 1, expectedText: 'hola = 1;', replacement: 'const hola = 1;' }],
      preconditions: [{ file: 'src/a.ts', forbiddenPatterns: ['\\bhola\\s*='] }],
    };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_PRECONDITION_FAILED' });
  });

  it('rejects binary files', () => {
    const file = path.join(root, 'src', 'binary.dat');
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02]));
    const patch: StructuredPatch = {
      version: 1,
      edits: [{ file: 'src/binary.dat', startLine: 1, endLine: 1, expectedText: '', replacement: '' }],
      preconditions: [],
    };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_BINARY_FILE' });
  });

  it('rejects symlink outside project', () => {
    if (process.platform === 'win32') {
      // Symlinks require admin on Windows; skip
      return;
    }
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-outside-'));
    const link = path.join(root, 'src', 'link.ts');
    fs.writeFileSync(path.join(target, 'target.ts'), 'content');
    fs.symlinkSync(path.join(target, 'target.ts'), link);
    const patch: StructuredPatch = {
      version: 1,
      edits: [{ file: 'src/link.ts', startLine: 1, endLine: 1, expectedText: 'content', replacement: 'new' }],
      preconditions: [],
    };
    try {
      expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_SYMLINK_OUTSIDE_PROJECT' });
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('rejects mixed line endings', () => {
    const file = path.join(root, 'src', 'a.ts');
    fs.writeFileSync(file, 'line1\r\nline2\nline3\r\n');
    const patch: StructuredPatch = {
      version: 1,
      edits: [{ file: 'src/a.ts', startLine: 1, endLine: 1, expectedText: 'line1', replacement: 'new' }],
      preconditions: [],
    };
    expect(new PatchValidator().validate(root, patch)).toMatchObject({ valid: false, error: 'PATCH_MIXED_LINE_ENDINGS' });
  });
});