import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { QualityIssue } from '@amp/core';
import { SqliteService } from './sqlite.service';

export interface QualitySnapshotRecord {
  id: string;
  projectId: string;
  provider: string;
  createdAt: string;
  totalIssues: number;
  severityCounts: Record<string, number>;
  typeCounts: Record<string, number> | null;
}

export interface CreateQualitySnapshotInput {
  projectId: string;
  provider: string;
  totalIssues: number;
  severityCounts: Record<string, number>;
  typeCounts?: Record<string, number> | null;
  issues?: QualityIssue[];
}

@Injectable()
export class QualitySnapshotRepository {
  constructor(private readonly sqlite: SqliteService) {}

  listByProjectId(projectId: string): QualitySnapshotRecord[] {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT id, project_id, provider, created_at, total_issues,
              severity_counts_json, type_counts_json
       FROM quality_snapshots
       WHERE project_id = ?
       ORDER BY created_at DESC`,
    );
    stmt.bind([projectId]);
    const rows: QualitySnapshotRecord[] = [];
    while (stmt.step()) {
      rows.push(this.mapSnapshot(stmt.getAsObject() as Record<string, unknown>));
    }
    stmt.free();
    return rows;
  }

  findById(id: string): QualitySnapshotRecord | null {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT id, project_id, provider, created_at, total_issues,
              severity_counts_json, type_counts_json
       FROM quality_snapshots WHERE id = ?`,
    );
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return this.mapSnapshot(row);
  }

  listIssues(snapshotId: string): QualityIssue[] {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT issue_id, rule, severity, type, status, message, file, line,
              effort, tags_json, creation_date, update_date
       FROM quality_snapshot_issues
       WHERE snapshot_id = ?
       ORDER BY severity, file, line`,
    );
    stmt.bind([snapshotId]);
    const issues: QualityIssue[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      issues.push(this.mapIssue(row, 'sonar'));
    }
    stmt.free();

    const snap = this.findById(snapshotId);
    if (snap) {
      return issues.map((issue) => ({ ...issue, provider: snap.provider }));
    }
    return issues;
  }

  create(input: CreateQualitySnapshotInput): QualitySnapshotRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const db = this.sqlite.getDb();
    db.run('BEGIN TRANSACTION');
    try {
    db.run(
      `INSERT INTO quality_snapshots
        (id, project_id, provider, created_at, total_issues,
         severity_counts_json, type_counts_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.projectId,
        input.provider,
        createdAt,
        input.totalIssues,
        JSON.stringify(input.severityCounts ?? {}),
        input.typeCounts ? JSON.stringify(input.typeCounts) : null,
      ],
    );

    const issues = input.issues ?? [];
    for (const issue of issues) {
      db.run(
        `INSERT INTO quality_snapshot_issues
          (id, snapshot_id, issue_id, rule, severity, type, status, message,
           file, line, effort, tags_json, creation_date, update_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          id,
          issue.id,
          issue.rule,
          issue.severity,
          issue.type ?? null,
          issue.status ?? null,
          issue.message,
          issue.file,
          issue.line ?? null,
          issue.effort ?? null,
          issue.tags ? JSON.stringify(issue.tags) : null,
          issue.creationDate ?? null,
          issue.updateDate ?? null,
        ],
      );
    }

    db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
    this.sqlite.persist();
    const saved = this.findById(id);
    if (!saved) {
      throw new Error('Failed to reload quality_snapshots');
    }
    return saved;
  }

  private mapSnapshot(row: Record<string, unknown>): QualitySnapshotRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      provider: String(row.provider),
      createdAt: String(row.created_at),
      totalIssues: Number(row.total_issues ?? 0),
      severityCounts: this.parseCounts(row.severity_counts_json),
      typeCounts: this.parseCountsOptional(row.type_counts_json),
    };
  }

  private mapIssue(
    row: Record<string, unknown>,
    provider: string,
  ): QualityIssue {
    let tags: string[] | undefined;
    if (typeof row.tags_json === 'string' && row.tags_json.length > 0) {
      try {
        const parsed: unknown = JSON.parse(row.tags_json);
        if (Array.isArray(parsed)) {
          tags = parsed.filter((t): t is string => typeof t === 'string');
        }
      } catch {
        tags = undefined;
      }
    }
    return {
      id: String(row.issue_id),
      provider,
      rule: String(row.rule),
      severity: String(row.severity),
      type: row.type == null ? undefined : String(row.type),
      status: row.status == null ? undefined : String(row.status),
      message: String(row.message ?? ''),
      file: String(row.file ?? ''),
      line:
        row.line === null || row.line === undefined
          ? undefined
          : Number(row.line),
      effort: row.effort == null ? undefined : String(row.effort),
      tags,
      creationDate:
        row.creation_date == null ? undefined : String(row.creation_date),
      updateDate:
        row.update_date == null ? undefined : String(row.update_date),
    };
  }

  private parseCounts(raw: unknown): Record<string, number> {
    if (typeof raw !== 'string' || !raw) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, number> = {};
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        const n = Number(value);
        if (Number.isFinite(n)) {
          out[key] = n;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private parseCountsOptional(
    raw: unknown,
  ): Record<string, number> | null {
    if (raw === null || raw === undefined || raw === '') {
      return null;
    }
    return this.parseCounts(raw);
  }
}
