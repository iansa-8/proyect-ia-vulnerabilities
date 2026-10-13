import { Injectable } from '@nestjs/common';
import { SqliteService } from './sqlite.service';

export interface ProjectQualityConfigRecord {
  projectId: string;
  provider: string;
  projectKey: string;
  /** Suggested / editable display name for remote project creation. */
  sonarProjectName: string | null;
  /** When true, ensure step may create the remote project. Default false. */
  autoCreateProject: boolean;
  /** Optional override; empty/null → use global SONAR_URL. */
  baseUrlOverride: string | null;
  updatedAt: string;
}

export interface UpsertProjectQualityConfigInput {
  projectId: string;
  provider?: string;
  projectKey: string;
  sonarProjectName?: string | null;
  autoCreateProject?: boolean;
  baseUrlOverride?: string | null;
}

@Injectable()
export class ProjectQualityConfigRepository {
  constructor(private readonly sqlite: SqliteService) {}

  findByProjectId(projectId: string): ProjectQualityConfigRecord | null {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT project_id, provider, project_key, sonar_project_name,
              auto_create_project, base_url_override, updated_at
       FROM project_quality_configs WHERE project_id = ?`,
    );
    stmt.bind([projectId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return this.map(row);
  }

  upsert(input: UpsertProjectQualityConfigInput): ProjectQualityConfigRecord {
    const now = new Date().toISOString();
    const existing = this.findByProjectId(input.projectId);
    const provider = input.provider ?? existing?.provider ?? 'sonar';
    const baseUrlOverride =
      input.baseUrlOverride === undefined
        ? (existing?.baseUrlOverride ?? null)
        : input.baseUrlOverride === ''
          ? null
          : input.baseUrlOverride;
    const sonarProjectName =
      input.sonarProjectName === undefined
        ? (existing?.sonarProjectName ?? null)
        : input.sonarProjectName === ''
          ? null
          : input.sonarProjectName;
    const autoCreateProject =
      input.autoCreateProject === undefined
        ? (existing?.autoCreateProject ?? false)
        : input.autoCreateProject;

    const db = this.sqlite.getDb();
    if (existing) {
      db.run(
        `UPDATE project_quality_configs
         SET provider = ?, project_key = ?, sonar_project_name = ?,
             auto_create_project = ?, base_url_override = ?, updated_at = ?
         WHERE project_id = ?`,
        [
          provider,
          input.projectKey,
          sonarProjectName,
          autoCreateProject ? 1 : 0,
          baseUrlOverride,
          now,
          input.projectId,
        ],
      );
    } else {
      db.run(
        `INSERT INTO project_quality_configs
          (project_id, provider, project_key, sonar_project_name,
           auto_create_project, base_url_override, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.projectId,
          provider,
          input.projectKey,
          sonarProjectName,
          autoCreateProject ? 1 : 0,
          baseUrlOverride,
          now,
        ],
      );
    }
    this.sqlite.persist();
    const saved = this.findByProjectId(input.projectId);
    if (!saved) {
      throw new Error('Failed to reload project_quality_configs');
    }
    return saved;
  }

  private map(row: Record<string, unknown>): ProjectQualityConfigRecord {
    return {
      projectId: String(row.project_id),
      provider: String(row.provider),
      projectKey: String(row.project_key ?? ''),
      sonarProjectName:
        row.sonar_project_name === null ||
        row.sonar_project_name === undefined ||
        row.sonar_project_name === ''
          ? null
          : String(row.sonar_project_name),
      autoCreateProject: Number(row.auto_create_project ?? 0) === 1,
      baseUrlOverride:
        row.base_url_override === null || row.base_url_override === undefined
          ? null
          : String(row.base_url_override),
      updatedAt: String(row.updated_at),
    };
  }
}
