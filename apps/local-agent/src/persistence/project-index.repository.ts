import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  isProjectIndexState,
  type ProjectIndexState,
} from '@amp/providers';
import { SqliteService } from './sqlite.service';

/** Bounded JSON metadata for index fingerprinting (not the knowledge graph). */
export interface ProjectIndexMetadata {
  workingTreeFingerprint?: string;
  workingTreeDirty?: boolean;
  indexedAtIso?: string;
}

export interface ProjectIndexRecord {
  id: string;
  projectId: string;
  provider: string;
  providerProjectName: string | null;
  status: ProjectIndexState;
  indexedAt: string | null;
  durationMs: number | null;
  gitCommit: string | null;
  filesCount: number | null;
  symbolsCount: number | null;
  relationshipsCount: number | null;
  error: string | null;
  metadata: ProjectIndexMetadata | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProjectIndexInput {
  projectId: string;
  provider: string;
  providerProjectName?: string | null;
  status: ProjectIndexState;
  indexedAt?: string | null;
  durationMs?: number | null;
  gitCommit?: string | null;
  filesCount?: number | null;
  symbolsCount?: number | null;
  relationshipsCount?: number | null;
  error?: string | null;
  metadata?: ProjectIndexMetadata | null;
}

@Injectable()
export class ProjectIndexRepository {
  constructor(private readonly sqlite: SqliteService) {}

  findByProjectId(projectId: string): ProjectIndexRecord | null {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT id, project_id, provider, provider_project_name, status,
              indexed_at, duration_ms, git_commit, files_count, symbols_count,
              relationships_count, error, metadata_json, created_at, updated_at
       FROM project_indexes WHERE project_id = ?`,
    );
    stmt.bind([projectId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return this.mapObject(row);
  }

  upsert(input: UpsertProjectIndexInput): ProjectIndexRecord {
    const existing = this.findByProjectId(input.projectId);
    const now = new Date().toISOString();
    if (existing) {
      const db = this.sqlite.getDb();
      db.run(
        `UPDATE project_indexes SET
           provider = ?,
           provider_project_name = ?,
           status = ?,
           indexed_at = ?,
           duration_ms = ?,
           git_commit = ?,
           files_count = ?,
           symbols_count = ?,
           relationships_count = ?,
           error = ?,
           metadata_json = ?,
           updated_at = ?
         WHERE project_id = ?`,
        [
          input.provider,
          input.providerProjectName ?? null,
          input.status,
          input.indexedAt ?? null,
          input.durationMs ?? null,
          input.gitCommit ?? null,
          input.filesCount ?? null,
          input.symbolsCount ?? null,
          input.relationshipsCount ?? null,
          input.error ?? null,
          this.serializeJson(input.metadata ?? null),
          now,
          input.projectId,
        ],
      );
      this.sqlite.persist();
      const updated = this.findByProjectId(input.projectId);
      if (!updated) {
        throw new Error('Failed to reload project_indexes after update');
      }
      return updated;
    }

    const record: ProjectIndexRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      provider: input.provider,
      providerProjectName: input.providerProjectName ?? null,
      status: input.status,
      indexedAt: input.indexedAt ?? null,
      durationMs: input.durationMs ?? null,
      gitCommit: input.gitCommit ?? null,
      filesCount: input.filesCount ?? null,
      symbolsCount: input.symbolsCount ?? null,
      relationshipsCount: input.relationshipsCount ?? null,
      error: input.error ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const db = this.sqlite.getDb();
    db.run(
      `INSERT INTO project_indexes
        (id, project_id, provider, provider_project_name, status, indexed_at,
         duration_ms, git_commit, files_count, symbols_count, relationships_count,
         error, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.provider,
        record.providerProjectName,
        record.status,
        record.indexedAt,
        record.durationMs,
        record.gitCommit,
        record.filesCount,
        record.symbolsCount,
        record.relationshipsCount,
        record.error,
        this.serializeJson(record.metadata),
        record.createdAt,
        record.updatedAt,
      ],
    );
    this.sqlite.persist();
    return record;
  }

  private serializeJson(value: ProjectIndexMetadata | null): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return JSON.stringify(value);
  }

  private parseMetadata(raw: unknown): ProjectIndexMetadata | null {
    if (raw === null || raw === undefined || raw === '') {
      return null;
    }
    if (typeof raw !== 'string') {
      return null;
    }
    try {
      return JSON.parse(raw) as ProjectIndexMetadata;
    } catch {
      return null;
    }
  }

  private mapObject(row: Record<string, unknown>): ProjectIndexRecord {
    const statusRaw = String(row.status);
    const status: ProjectIndexState = isProjectIndexState(statusRaw)
      ? statusRaw
      : 'failed';
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      provider: String(row.provider),
      providerProjectName:
        row.provider_project_name === null ||
        row.provider_project_name === undefined
          ? null
          : String(row.provider_project_name),
      status,
      indexedAt:
        row.indexed_at === null || row.indexed_at === undefined
          ? null
          : String(row.indexed_at),
      durationMs:
        row.duration_ms === null || row.duration_ms === undefined
          ? null
          : Number(row.duration_ms),
      gitCommit:
        row.git_commit === null || row.git_commit === undefined
          ? null
          : String(row.git_commit),
      filesCount:
        row.files_count === null || row.files_count === undefined
          ? null
          : Number(row.files_count),
      symbolsCount:
        row.symbols_count === null || row.symbols_count === undefined
          ? null
          : Number(row.symbols_count),
      relationshipsCount:
        row.relationships_count === null ||
        row.relationships_count === undefined
          ? null
          : Number(row.relationships_count),
      error:
        row.error === null || row.error === undefined
          ? null
          : String(row.error),
      metadata: this.parseMetadata(row.metadata_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
