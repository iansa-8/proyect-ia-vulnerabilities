import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteService } from './sqlite.service';
import { QualitySnapshotRepository } from './quality-snapshot.repository';

describe('Quality snapshot history in SQLite', () => {
  let sqlite: SqliteService;
  let repo: QualitySnapshotRepository;
  let dir: string;
  const saved = process.env.SQLITE_PATH;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-snapshot-test-'));
    process.env.SQLITE_PATH = path.join(dir, 'test.sqlite');
    sqlite = new SqliteService();
    await sqlite.onModuleInit();
    repo = new QualitySnapshotRepository(sqlite);
  });
  afterEach(() => {
    sqlite.onModuleDestroy();
    if (saved === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const input = {
    projectId: 'project-test', provider: 'sonar', totalIssues: 1,
    severityCounts: { MAJOR: 1 }, typeCounts: { CODE_SMELL: 1 },
    issues: [{ id: 'I1', provider: 'sonar', rule: 'ts:S1', severity: 'MAJOR', type: 'CODE_SMELL',
      status: 'OPEN', message: 'message', file: 'src/a.ts', line: 8,
      effort: '5min', tags: ['test'], creationDate: '2026-09-22T00:00:00Z', updateDate: '2026-09-23T00:00:00Z' }],
  };
  it('persists all issue fields and aggregate totals', () => {
    const snapshot = repo.create(input);
    expect(snapshot.createdAt).toBeTruthy();
    expect(snapshot.totalIssues).toBe(1);
    expect(snapshot.severityCounts).toEqual({ MAJOR: 1 });
    expect(snapshot.typeCounts).toEqual({ CODE_SMELL: 1 });
    expect(repo.listIssues(snapshot.id)).toEqual(input.issues);
  });
  it('creates independent snapshots for repeated analysis', () => {
    const first = repo.create(input);
    const second = repo.create({ ...input, totalIssues: 0, issues: [], severityCounts: {}, typeCounts: {} });
    expect(second.id).not.toBe(first.id);
    expect(repo.listByProjectId(input.projectId)).toHaveLength(2);
    expect(repo.findById(first.id)?.totalIssues).toBe(1);
    expect(repo.listIssues(first.id)).toHaveLength(1);
    expect(repo.listIssues(second.id)).toHaveLength(0);
  });
  it('rolls back the whole snapshot if an issue cannot be inserted', () => {
    const run = jest.spyOn(sqlite.getDb(), 'run');
    const original = run.getMockImplementation()!;
    run.mockImplementation(function (...args) {
      if (String(args[0]).includes('INSERT INTO quality_snapshot_issues')) throw new Error('fixture insert failure');
      return original.apply(sqlite.getDb(), args);
    });
    expect(() => repo.create(input)).toThrow('fixture insert failure');
    run.mockRestore();
    expect(repo.listByProjectId(input.projectId)).toEqual([]);
  });
});
