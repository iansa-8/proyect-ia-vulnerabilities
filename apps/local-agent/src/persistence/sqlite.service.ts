import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { loadConfig } from '../config/app-config';

@Injectable()
export class SqliteService implements OnModuleInit, OnModuleDestroy {
  private SQL: SqlJsStatic | null = null;
  private db: Database | null = null;
  private dbPath = '';
  private ready = false;

  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    this.dbPath = config.sqlitePath;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.SQL = await initSqlJs();
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(fileBuffer);
    } else {
      this.db = new this.SQL.Database();
    }

    this.migrate();
    this.persist();
    this.ready = true;
  }

  onModuleDestroy(): void {
    if (this.db) {
      this.persist();
      this.db.close();
      this.db = null;
    }
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getDb(): Database {
    if (!this.db) {
      throw new Error('SQLite database is not initialized');
    }
    return this.db;
  }

  persist(): void {
    if (!this.db) {
      return;
    }
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  private migrate(): void {
    const db = this.getDb();
    db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        profile_json TEXT,
        command_overrides_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn('projects', 'profile_json', 'TEXT');
    this.ensureColumn('projects', 'command_overrides_json', 'TEXT');
    db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    this.ensureColumn('pipeline_runs', 'pipeline_definition_id', 'TEXT');
    this.ensureColumn('pipeline_runs', 'started_at', 'TEXT');
    this.ensureColumn('pipeline_runs', 'finished_at', 'TEXT');
    this.ensureColumn('pipeline_runs', 'duration_ms', 'INTEGER');
    this.ensureColumn('pipeline_runs', 'error', 'TEXT');
    db.run(`
      CREATE TABLE IF NOT EXISTS pipeline_step_runs (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        result_json TEXT,
        error TEXT,
        step_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id)
      );
    `);
    // Index metadata only — Codebase Memory owns the knowledge graph.
    db.run(`
      CREATE TABLE IF NOT EXISTS project_indexes (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        provider_project_name TEXT,
        status TEXT NOT NULL,
        indexed_at TEXT,
        duration_ms INTEGER,
        git_commit TEXT,
        files_count INTEGER,
        symbols_count INTEGER,
        relationships_count INTEGER,
        error TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    // Per-project quality config — never stores tokens.
    db.run(`
      CREATE TABLE IF NOT EXISTS project_quality_configs (
        project_id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL DEFAULT 'sonar',
        project_key TEXT NOT NULL DEFAULT '',
        base_url_override TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    this.ensureColumn('project_quality_configs', 'sonar_project_name', 'TEXT');
    this.ensureColumn(
      'project_quality_configs',
      'auto_create_project',
      'INTEGER DEFAULT 0',
    );
    // Aggregated quality snapshots (not raw HTTP payloads).
    db.run(`
      CREATE TABLE IF NOT EXISTS quality_snapshots (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL,
        total_issues INTEGER NOT NULL DEFAULT 0,
        severity_counts_json TEXT NOT NULL DEFAULT '{}',
        type_counts_json TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS quality_snapshot_issues (
        id TEXT PRIMARY KEY NOT NULL,
        snapshot_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        rule TEXT NOT NULL,
        severity TEXT NOT NULL,
        type TEXT,
        status TEXT,
        message TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER,
        effort TEXT,
        tags_json TEXT,
        creation_date TEXT,
        update_date TEXT,
        FOREIGN KEY (snapshot_id) REFERENCES quality_snapshots(id)
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS agent_proposals (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_version TEXT,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        diagnosis TEXT,
        affected_files_json TEXT NOT NULL,
        proposed_changes_json TEXT NOT NULL,
         patch_json TEXT,
        agent_suggested_risk TEXT NOT NULL,
        validation_plan_json TEXT NOT NULL,
        assumptions_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        duration_ms INTEGER,
        status TEXT NOT NULL,
        context_files_json TEXT NOT NULL DEFAULT '[]',
        context_size_chars INTEGER NOT NULL DEFAULT 0,
        repository_unchanged INTEGER NOT NULL DEFAULT 0,
        execution_trace_json TEXT,
        context_revision TEXT,
        context_file_hashes_json TEXT NOT NULL DEFAULT '{}',
        approved_at TEXT,
        approved_by TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    this.ensureColumn('agent_proposals', 'patch_json', 'TEXT');
    this.ensureColumn('agent_proposals', 'execution_trace_json', 'TEXT');
    this.ensureColumn('agent_proposals', 'context_revision', 'TEXT');
    this.ensureColumn('agent_proposals', 'context_file_hashes_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('agent_proposals', 'approved_at', 'TEXT');
    this.ensureColumn('agent_proposals', 'approved_by', 'TEXT');
    this.ensureColumn('agent_proposals', 'remediation_strategy', 'TEXT');
    this.ensureColumn('agent_proposals', 'remediation_reason', 'TEXT');
    this.ensureColumn('agent_proposals', 'estimated_input_tokens', 'INTEGER');
    this.ensureColumn('agent_proposals', 'input_tokens', 'INTEGER');
    this.ensureColumn('agent_proposals', 'output_tokens', 'INTEGER');
    this.ensureColumn('agent_proposals', 'requires_agent', 'INTEGER DEFAULT 0');
    this.ensureColumn('agent_proposals', 'escalation_reason', 'TEXT');
    db.run(`
      CREATE TABLE IF NOT EXISTS fix_application_reports (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (proposal_id) REFERENCES agent_proposals(id)
      );
    `);
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const db = this.getDb();
    const result = db.exec(`PRAGMA table_info(${table})`);
    if (result.length === 0) {
      return;
    }
    const nameIndex = result[0].columns.indexOf('name');
    if (nameIndex < 0) {
      return;
    }
    const exists = result[0].values.some(
      (row) => String(row[nameIndex]) === column,
    );
    if (!exists) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}
