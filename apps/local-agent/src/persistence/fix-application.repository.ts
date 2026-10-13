import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SqliteService } from './sqlite.service';

export type FixApplicationStatus =
  | 'approved' | 'applying' | 'validating' | 'validation_failed'
  | 'rolling_back' | 'rolled_back' | 'validation_passed'
  | 'quality_rechecking' | 'review_required' | 'completed' | 'rollback_failed';

export interface FixApplicationReport {
  id: string;
  runId: string;
  projectId: string;
  issueId: string;
  proposalId: string;
  approvedBy: string;
  approvedAt: string;
  status: FixApplicationStatus;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

@Injectable()
export class FixApplicationRepository {
  constructor(private readonly sqlite: SqliteService) {}

  upsert(input: Omit<FixApplicationReport, 'id' | 'createdAt' | 'updatedAt'>): FixApplicationReport {
    const existing = this.findByRunId(input.runId);
    const now = new Date().toISOString();
    const record: FixApplicationReport = {
      ...input,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const db = this.sqlite.getDb();
    if (existing) {
      db.run(
        `UPDATE fix_application_reports SET status = ?, updated_at = ?, data_json = ? WHERE run_id = ?`,
        [record.status, record.updatedAt, JSON.stringify(record.data), record.runId],
      );
    } else {
      db.run(
        `INSERT INTO fix_application_reports
         (id, run_id, project_id, issue_id, proposal_id, approved_by, approved_at,
          status, created_at, updated_at, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [record.id, record.runId, record.projectId, record.issueId, record.proposalId,
          record.approvedBy, record.approvedAt, record.status, record.createdAt,
          record.updatedAt, JSON.stringify(record.data)],
      );
    }
    this.sqlite.persist();
    return this.findByRunId(record.runId) ?? record;
  }

  findByRunId(runId: string): FixApplicationReport | null {
    const stmt = this.sqlite.getDb().prepare('SELECT * FROM fix_application_reports WHERE run_id = ?');
    stmt.bind([runId]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return this.map(row);
  }

  listByProposalId(proposalId: string): FixApplicationReport[] {
    const stmt = this.sqlite.getDb().prepare(
      'SELECT * FROM fix_application_reports WHERE proposal_id = ? ORDER BY created_at DESC',
    );
    stmt.bind([proposalId]);
    const rows: FixApplicationReport[] = [];
    while (stmt.step()) rows.push(this.map(stmt.getAsObject()));
    stmt.free();
    return rows;
  }

  private map(row: Record<string, unknown>): FixApplicationReport {
    return {
      id: String(row.id), runId: String(row.run_id), projectId: String(row.project_id),
      issueId: String(row.issue_id), proposalId: String(row.proposal_id),
      approvedBy: String(row.approved_by), approvedAt: String(row.approved_at),
      status: String(row.status) as FixApplicationStatus,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      data: JSON.parse(String(row.data_json ?? '{}')) as Record<string, unknown>,
    };
  }
}
