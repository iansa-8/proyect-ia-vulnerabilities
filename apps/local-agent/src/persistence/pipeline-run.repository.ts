import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PipelineRunRecord, StepRunRecord } from '@amp/pipeline';
import { SqliteService } from './sqlite.service';

const MAX_RESULT_JSON_CHARS = 8_192;

@Injectable()
export class PipelineRunRepository {
  constructor(private readonly sqlite: SqliteService) {}

  recoverInterruptedRuns(): number {
    const db = this.sqlite.getDb();
    const finishedAt = new Date().toISOString();
    db.run('BEGIN TRANSACTION');
    try {
      db.run(
        `UPDATE pipeline_step_runs
         SET status = 'failed', finished_at = ?,
             error = COALESCE(error, 'Execution interrupted by local-agent restart')
         WHERE status = 'running'`,
        [finishedAt],
      );
      db.run(
        `UPDATE pipeline_runs
         SET status = 'failed', finished_at = ?, updated_at = ?,
             error = COALESCE(error, 'Execution interrupted by local-agent restart')
         WHERE status IN ('pending', 'running')`,
        [finishedAt, finishedAt],
      );
      const recovered = db.getRowsModified();
      db.run('COMMIT');
      this.sqlite.persist();
      return recovered;
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }

  list(): PipelineRunRecord[] {
    const db = this.sqlite.getDb();
    const result = db.exec(
      `SELECT id, pipeline_definition_id, project_id, status,
              started_at, finished_at, duration_ms, error, created_at, updated_at
       FROM pipeline_runs ORDER BY created_at DESC`,
    );
    if (result.length === 0) {
      return [];
    }
    const { columns, values } = result[0];
    return values.map((row) => this.mapRunRow(columns, row));
  }

  findById(id: string): PipelineRunRecord | null {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT id, pipeline_definition_id, project_id, status,
              started_at, finished_at, duration_ms, error, created_at, updated_at
       FROM pipeline_runs WHERE id = ?`,
    );
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return this.mapRunObject(row);
  }

  create(input: {
    projectId: string;
    pipelineDefinitionId: string;
  }): PipelineRunRecord {
    const now = new Date().toISOString();
    const record: PipelineRunRecord = {
      id: randomUUID(),
      pipelineDefinitionId: input.pipelineDefinitionId,
      projectId: input.projectId,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const db = this.sqlite.getDb();
    db.run(
      `INSERT INTO pipeline_runs
        (id, pipeline_definition_id, project_id, status,
         started_at, finished_at, duration_ms, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.pipelineDefinitionId,
        record.projectId,
        record.status,
        record.startedAt,
        record.finishedAt,
        record.durationMs,
        record.error,
        record.createdAt,
        record.updatedAt,
      ],
    );
    this.sqlite.persist();
    return record;
  }

  updateRun(input: {
    id: string;
    status: PipelineRunRecord['status'];
    startedAt?: string | null;
    finishedAt?: string | null;
    durationMs?: number | null;
    error?: string | null;
  }): PipelineRunRecord | null {
    const existing = this.findById(input.id);
    if (!existing) {
      return null;
    }
    const now = new Date().toISOString();
    const db = this.sqlite.getDb();
    db.run(
      `UPDATE pipeline_runs
       SET status = ?, started_at = ?, finished_at = ?, duration_ms = ?,
           error = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.status,
        input.startedAt !== undefined ? input.startedAt : existing.startedAt,
        input.finishedAt !== undefined ? input.finishedAt : existing.finishedAt,
        input.durationMs !== undefined ? input.durationMs : existing.durationMs,
        input.error !== undefined ? input.error : existing.error,
        now,
        input.id,
      ],
    );
    this.sqlite.persist();
    return this.findById(input.id);
  }

  upsertStep(input: {
    runId: string;
    stepId: string;
    name: string;
    status: StepRunRecord['status'];
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    result?: unknown;
    error?: string | null;
    stepOrder: number;
  }): StepRunRecord {
    const existing = this.findStep(input.runId, input.stepId);
    const resultJson = this.serializeResult(input.result);
    const db = this.sqlite.getDb();

    if (existing) {
      db.run(
        `UPDATE pipeline_step_runs
         SET name = ?, status = ?, started_at = ?, finished_at = ?,
             duration_ms = ?, result_json = ?, error = ?, step_order = ?
         WHERE id = ?`,
        [
          input.name,
          input.status,
          input.startedAt,
          input.finishedAt,
          input.durationMs,
          resultJson,
          input.error ?? null,
          input.stepOrder,
          existing.id,
        ],
      );
      this.sqlite.persist();
      return this.findStep(input.runId, input.stepId) ?? existing;
    }

    const record: StepRunRecord = {
      id: randomUUID(),
      runId: input.runId,
      stepId: input.stepId,
      name: input.name,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      resultJson,
      error: input.error ?? null,
      stepOrder: input.stepOrder,
    };
    db.run(
      `INSERT INTO pipeline_step_runs
        (id, run_id, step_id, name, status, started_at, finished_at,
         duration_ms, result_json, error, step_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.runId,
        record.stepId,
        record.name,
        record.status,
        record.startedAt,
        record.finishedAt,
        record.durationMs,
        record.resultJson,
        record.error,
        record.stepOrder,
      ],
    );
    this.sqlite.persist();
    return record;
  }

  listSteps(runId: string): StepRunRecord[] {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT id, run_id, step_id, name, status, started_at, finished_at,
              duration_ms, result_json, error, step_order
       FROM pipeline_step_runs
       WHERE run_id = ?
       ORDER BY step_order ASC`,
    );
    stmt.bind([runId]);
    const rows: StepRunRecord[] = [];
    while (stmt.step()) {
      rows.push(this.mapStepObject(stmt.getAsObject() as Record<string, unknown>));
    }
    stmt.free();
    return rows;
  }

  private findStep(runId: string, stepId: string): StepRunRecord | null {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT id, run_id, step_id, name, status, started_at, finished_at,
              duration_ms, result_json, error, step_order
       FROM pipeline_step_runs WHERE run_id = ? AND step_id = ?`,
    );
    stmt.bind([runId, stepId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return this.mapStepObject(row);
  }

  private serializeResult(result: unknown): string | null {
    if (result === undefined) {
      return null;
    }
    try {
      const raw = JSON.stringify(result);
      if (raw.length <= MAX_RESULT_JSON_CHARS) {
        return raw;
      }
      return JSON.stringify({
        truncated: true,
        preview: raw.slice(0, MAX_RESULT_JSON_CHARS),
      });
    } catch {
      return JSON.stringify({ error: 'unserializable result' });
    }
  }

  private mapRunObject(row: Record<string, unknown>): PipelineRunRecord {
    return {
      id: String(row.id),
      pipelineDefinitionId: String(row.pipeline_definition_id ?? ''),
      projectId: String(row.project_id),
      status: String(row.status) as PipelineRunRecord['status'],
      startedAt: row.started_at == null ? null : String(row.started_at),
      finishedAt: row.finished_at == null ? null : String(row.finished_at),
      durationMs:
        row.duration_ms == null || row.duration_ms === ''
          ? null
          : Number(row.duration_ms),
      error: row.error == null ? null : String(row.error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapRunRow(columns: string[], row: unknown[]): PipelineRunRecord {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, index) => {
      obj[col] = row[index];
    });
    return this.mapRunObject(obj);
  }

  private mapStepObject(row: Record<string, unknown>): StepRunRecord {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      stepId: String(row.step_id),
      name: String(row.name),
      status: String(row.status) as StepRunRecord['status'],
      startedAt: row.started_at == null ? null : String(row.started_at),
      finishedAt: row.finished_at == null ? null : String(row.finished_at),
      durationMs:
        row.duration_ms == null || row.duration_ms === ''
          ? null
          : Number(row.duration_ms),
      resultJson: row.result_json == null ? null : String(row.result_json),
      error: row.error == null ? null : String(row.error),
      stepOrder: Number(row.step_order ?? 0),
    };
  }

  private mapStepRow(columns: string[], row: unknown[]): StepRunRecord {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, index) => {
      obj[col] = row[index];
    });
    return this.mapStepObject(obj);
  }
}
