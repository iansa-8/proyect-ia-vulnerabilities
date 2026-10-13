import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  ProjectCommandOverrides,
  ProjectProfile,
  ProjectRecord,
} from '@amp/core';
import { SqliteService } from './sqlite.service';

@Injectable()
export class ProjectRepository {
  constructor(private readonly sqlite: SqliteService) {}

  list(): ProjectRecord[] {
    const db = this.sqlite.getDb();
    const result = db.exec(
      `SELECT id, name, path, profile_json, command_overrides_json, created_at, updated_at
       FROM projects ORDER BY created_at DESC`,
    );
    if (result.length === 0) {
      return [];
    }
    const { columns, values } = result[0];
    return values.map((row) => this.mapRow(columns, row));
  }

  findById(id: string): ProjectRecord | null {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT id, name, path, profile_json, command_overrides_json, created_at, updated_at
       FROM projects WHERE id = ?`,
    );
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return this.mapObject(row);
  }

  findByPath(projectPath: string): ProjectRecord | null {
    const db = this.sqlite.getDb();
    const stmt = db.prepare(
      `SELECT id, name, path, profile_json, command_overrides_json, created_at, updated_at
       FROM projects WHERE path = ?`,
    );
    stmt.bind([projectPath]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return this.mapObject(row);
  }

  create(input: {
    name: string;
    path: string;
    profile?: ProjectProfile;
    commandOverrides?: ProjectCommandOverrides;
  }): ProjectRecord {
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: randomUUID(),
      name: input.name,
      path: input.path,
      profile: input.profile,
      commandOverrides: input.commandOverrides,
      createdAt: now,
      updatedAt: now,
    };
    const db = this.sqlite.getDb();
    db.run(
      `INSERT INTO projects
        (id, name, path, profile_json, command_overrides_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.name,
        record.path,
        this.serializeJson(record.profile),
        this.serializeJson(record.commandOverrides),
        record.createdAt,
        record.updatedAt,
      ],
    );
    this.sqlite.persist();
    return record;
  }

  updateProfile(
    id: string,
    profile: ProjectProfile,
    name?: string,
  ): ProjectRecord | null {
    const existing = this.findById(id);
    if (!existing) {
      return null;
    }
    const now = new Date().toISOString();
    const nextName = name?.trim() ? name.trim() : existing.name;
    const db = this.sqlite.getDb();
    db.run(
      `UPDATE projects
       SET name = ?, profile_json = ?, updated_at = ?
       WHERE id = ?`,
      [nextName, this.serializeJson(profile), now, id],
    );
    this.sqlite.persist();
    return this.findById(id);
  }

  updateCommandOverrides(
    id: string,
    overrides: ProjectCommandOverrides,
  ): ProjectRecord | null {
    const existing = this.findById(id);
    if (!existing) {
      return null;
    }
    const now = new Date().toISOString();
    const db = this.sqlite.getDb();
    db.run(
      `UPDATE projects
       SET command_overrides_json = ?, updated_at = ?
       WHERE id = ?`,
      [this.serializeJson(overrides), now, id],
    );
    this.sqlite.persist();
    return this.findById(id);
  }

  private serializeJson(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    return JSON.stringify(value);
  }

  private parseJson<T>(raw: unknown): T | undefined {
    if (raw === null || raw === undefined || raw === '') {
      return undefined;
    }
    if (typeof raw !== 'string') {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private mapObject(row: Record<string, unknown>): ProjectRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      path: String(row.path),
      profile: this.parseJson<ProjectProfile>(row.profile_json),
      commandOverrides: this.parseJson<ProjectCommandOverrides>(
        row.command_overrides_json,
      ),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapRow(columns: string[], row: unknown[]): ProjectRecord {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, index) => {
      obj[col] = row[index];
    });
    return this.mapObject(obj);
  }
}
