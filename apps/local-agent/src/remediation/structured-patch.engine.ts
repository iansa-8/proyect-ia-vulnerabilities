import { Injectable, Inject } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PatchLineEdit,
  StructuredPatch,
} from '@amp/core';
import { PatchValidator } from './patch-validator.service';

export interface StructuredPatchApplyResult {
  success: boolean;
  changedFiles: string[];
  editCount: number;
  error?: string;
}

interface FileState {
  absolutePath: string;
  original: string;
  eol: '\n' | '\r\n';
  lines: string[];
}

const MAX_REANCHOR_LINE_DRIFT = 25;

/**
 * Applies only explicit, reviewable line edits. It does not execute code,
 * infer a diff, or delegate to a coding agent.
 */
@Injectable()
export class StructuredPatchEngine {
  constructor(
    @Inject(PatchValidator) private readonly patchValidator: PatchValidator,
  ) {}

  apply(projectPath: string, patch: StructuredPatch): StructuredPatchApplyResult {
    const validation = this.patchValidator.validate(projectPath, patch);
    if (!validation.valid) {
      return failure([], 0, validation.error ?? 'PATCH_VALIDATION_FAILED');
    }

    let root: string;
    try {
      root = fs.realpathSync(path.resolve(projectPath));
    } catch {
      return failure([], 0, 'PROJECT_PATH_UNAVAILABLE');
    }

    try {
      const states = this.readFiles(root, new Set(validation.files));
      const nextContents = this.applyEdits(states, validation.edits);
      const changed = [...new Set(validation.edits.map((edit) => edit.file))].filter((file) => {
        const state = states.get(file);
        return state !== undefined && nextContents.get(file) !== state.original;
      });

      const written: string[] = [];
      try {
        for (const [file, content] of nextContents) {
          const state = states.get(file);
          if (!state || content === state.original) continue;
          fs.writeFileSync(state.absolutePath, content, 'utf8');
          written.push(file);
        }
      } catch (error: unknown) {
        for (const file of written.reverse()) {
          const state = states.get(file);
          if (state) fs.writeFileSync(state.absolutePath, state.original, 'utf8');
        }
        throw error;
      }

      return {
        success: true,
        changedFiles: changed,
        editCount: validation.edits.length,
      };
    } catch (error: unknown) {
      return failure([], 0, error instanceof Error ? error.message : 'PATCH_APPLY_FAILED');
    }
  }

  private readFiles(root: string, files: Set<string>): Map<string, FileState> {
    const states = new Map<string, FileState>();
    for (const file of files) {
      const absolute = path.resolve(root, file);
      const real = fs.realpathSync(absolute);
      const buffer = fs.readFileSync(real);
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

  private applyEdits(states: Map<string, FileState>, edits: PatchLineEdit[]): Map<string, string> {
    const next = new Map<string, string>();
    for (const [file, state] of states) {
      const lines = [...state.lines];
      const fileEdits = edits
        .filter((edit) => edit.file === file)
        .map((edit) => this.reanchorExactEdit(state, edit))
        .sort((a, b) => b.startLine - a.startLine || b.endLine - a.endLine);
      for (const edit of fileEdits) {
        if (edit.endLine > lines.length) throw new Error('PATCH_LINE_OUT_OF_RANGE');
        const expected = lines.slice(edit.startLine - 1, edit.endLine).join('\n');
        if (expected !== edit.expectedText) throw new Error('PATCH_EXPECTED_TEXT_MISMATCH');
        lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.replacement.split('\n'));
      }
      next.set(file, lines.join(state.eol));
    }
    return next;
  }

  /**
   * Index line metadata can lag a small local edit. A patch remains safe when
   * its exact expected text appears exactly once near the declared range. Do
   * not infer a replacement or accept an ambiguous match.
   */
  private reanchorExactEdit(state: FileState, edit: PatchLineEdit): PatchLineEdit {
    const expectedLines = edit.expectedText.split('\n');
    const atDeclaredRange = state.lines
      .slice(edit.startLine - 1, edit.endLine)
      .join('\n');
    if (atDeclaredRange === edit.expectedText) return edit;

    const matches: number[] = [];
    for (let index = 0; index <= state.lines.length - expectedLines.length; index += 1) {
      if (state.lines.slice(index, index + expectedLines.length).join('\n') === edit.expectedText) {
        matches.push(index + 1);
      }
    }
    if (
      matches.length !== 1 ||
      Math.abs(matches[0] - edit.startLine) > MAX_REANCHOR_LINE_DRIFT
    ) {
      throw new Error('PATCH_EXPECTED_TEXT_MISMATCH');
    }
    return {
      ...edit,
      startLine: matches[0],
      endLine: matches[0] + expectedLines.length - 1,
    };
  }
}

function failure(changedFiles: string[], editCount: number, error: string): StructuredPatchApplyResult {
  return { success: false, changedFiles, editCount, error };
}
