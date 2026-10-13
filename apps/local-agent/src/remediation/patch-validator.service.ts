import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PatchLineEdit,
  PatchPrecondition,
  StructuredPatch,
} from '@amp/core';

export interface PatchValidationResult {
  valid: boolean;
  error?: string;
  files: string[];
  edits: PatchLineEdit[];
  preconditions: PatchPrecondition[];
}

interface FileState {
  absolutePath: string;
  original: string;
  eol: '\n' | '\r\n';
  lines: string[];
}

const MAX_EDITS = 50;
const MAX_TEXT_CHARS = 100_000;
const MAX_PATTERN_CHARS = 500;
const SENSITIVE_PATH = /(^|\/)(node_modules(?:\/|$)|\.git(?:\/|$)|\.env(?:\..*)?|credentials?(?:\/|$)|secrets?(?:\/|$)|service[-_.]?account.*|.*\.(?:pem|key|p12|pfx)$)/i;

/**
 * Validates a StructuredPatch without applying it.
 * Checks: version, structure, path safety, line ranges, text limits,
 * overlapping edits, preconditions, file existence, binary detection,
 * symlink safety, and line-ending consistency.
 */
@Injectable()
export class PatchValidator {
  validate(projectPath: string, patch: StructuredPatch): PatchValidationResult {
    let root: string;
    try {
      root = fs.realpathSync(path.resolve(projectPath));
    } catch {
      return { valid: false, error: 'PROJECT_PATH_UNAVAILABLE', files: [], edits: [], preconditions: [] };
    }

    try {
      const normalized = this.validatePatch(patch);
      const states = this.readFiles(root, normalized.files);
      this.checkPreconditions(states, normalized.preconditions);

      return {
        valid: true,
        files: [...normalized.files],
        edits: normalized.edits,
        preconditions: normalized.preconditions,
      };
    } catch (error: unknown) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'PATCH_VALIDATION_FAILED',
        files: [],
        edits: [],
        preconditions: [],
      };
    }
  }

  private validatePatch(patch: StructuredPatch): {
    edits: PatchLineEdit[];
    preconditions: PatchPrecondition[];
    files: Set<string>;
  } {
    if (!patch || patch.version !== 1 || !Array.isArray(patch.edits) || patch.edits.length === 0) {
      throw new Error('PATCH_INVALID');
    }
    if (patch.edits.length > MAX_EDITS || !Array.isArray(patch.preconditions)) {
      throw new Error('PATCH_TOO_LARGE');
    }

    const edits = patch.edits.map((edit) => this.normalizeEdit(edit));
    const files = new Set<string>();
    const byFile = new Map<string, PatchLineEdit[]>();
    for (const edit of edits) {
      files.add(edit.file);
      const list = byFile.get(edit.file) ?? [];
      list.push(edit);
      byFile.set(edit.file, list);
    }
    for (const list of byFile.values()) {
      const sorted = [...list].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index].startLine <= sorted[index - 1].endLine) {
          throw new Error('PATCH_OVERLAPPING_EDITS');
        }
      }
    }

    const preconditions = patch.preconditions.map((precondition) => this.normalizePrecondition(precondition));
    for (const precondition of preconditions) files.add(precondition.file);
    return { edits, preconditions, files };
  }

  private normalizeEdit(edit: PatchLineEdit): PatchLineEdit {
    if (!edit || typeof edit.file !== 'string' || !Number.isSafeInteger(edit.startLine) || !Number.isSafeInteger(edit.endLine)) {
      throw new Error('PATCH_INVALID');
    }
    const file = normalizeRelativeFile(edit.file);
    if (edit.startLine < 1 || edit.endLine < edit.startLine || edit.endLine > 10_000_000) {
      throw new Error('PATCH_INVALID_LINE_RANGE');
    }
    if (typeof edit.expectedText !== 'string' || typeof edit.replacement !== 'string'
      || edit.expectedText.length > MAX_TEXT_CHARS || edit.replacement.length > MAX_TEXT_CHARS) {
      throw new Error('PATCH_INVALID_TEXT');
    }
    return { ...edit, file };
  }

  private normalizePrecondition(precondition: PatchPrecondition): PatchPrecondition {
    if (!precondition || typeof precondition.file !== 'string' || !Array.isArray(precondition.forbiddenPatterns)
      || precondition.forbiddenPatterns.length > 20
      || precondition.forbiddenPatterns.some((pattern) => typeof pattern !== 'string' || pattern.length > MAX_PATTERN_CHARS)) {
      throw new Error('PATCH_INVALID_PRECONDITION');
    }
    for (const pattern of precondition.forbiddenPatterns) {
      try {
        new RegExp(pattern);
      } catch {
        throw new Error('PATCH_INVALID_PRECONDITION_PATTERN');
      }
    }
    return { file: normalizeRelativeFile(precondition.file), forbiddenPatterns: [...precondition.forbiddenPatterns] };
  }

  private readFiles(root: string, files: Set<string>): Map<string, FileState> {
    const states = new Map<string, FileState>();
    for (const file of files) {
      if (SENSITIVE_PATH.test(file)) throw new Error('PATCH_SENSITIVE_FILE');
      const absolute = path.resolve(root, file);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('PATCH_PATH_OUTSIDE_PROJECT');
      let real: string;
      try {
        real = fs.realpathSync(absolute);
      } catch {
        throw new Error('PATCH_FILE_NOT_FOUND');
      }
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error('PATCH_SYMLINK_OUTSIDE_PROJECT');
      if (!fs.statSync(real).isFile()) throw new Error('PATCH_FILE_NOT_REGULAR');
      const buffer = fs.readFileSync(real);
      if (buffer.includes(0)) throw new Error('PATCH_BINARY_FILE');
      const original = buffer.toString('utf8');
      const hasCrlf = original.includes('\r\n');
      const hasBareLf = /(^|[^\r])\n/.test(original);
      if (hasCrlf && hasBareLf) throw new Error('PATCH_MIXED_LINE_ENDINGS');
      const eol: '\n' | '\r\n' = hasCrlf ? '\r\n' : '\n';
      states.set(file, {
        absolutePath: real,
        original,
        eol,
        lines: original.split(/\r?\n/),
      });
    }
    return states;
  }

  private checkPreconditions(states: Map<string, FileState>, preconditions: PatchPrecondition[]): void {
    for (const precondition of preconditions) {
      const state = states.get(precondition.file);
      if (!state) throw new Error('PATCH_PRECONDITION_FILE_NOT_FOUND');
      for (const pattern of precondition.forbiddenPatterns) {
        const expression = new RegExp(pattern);
        if (expression.test(state.original)) {
          throw new Error('PATCH_PRECONDITION_FAILED');
        }
      }
    }
  }
}

function normalizeRelativeFile(file: string): string {
  const value = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').includes('..')) {
    throw new Error('PATCH_INVALID_PATH');
  }
  return value;
}
