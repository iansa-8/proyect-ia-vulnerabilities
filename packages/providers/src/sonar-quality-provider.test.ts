import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  QualityProviderError,
  SonarQualityProvider,
  type SonarFetch,
} from './sonar-quality-provider';

const BASE = 'http://sonar.test:9000';
const TOKEN = 'super-secret-sonar-token-value';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('SonarQualityProvider', () => {
  it('rejects missing totals and invalid identity without silently dropping issues', async () => {
    for (const payload of [
      { issues: [] },
      { total: -1, issues: [] },
      { total: 1, issues: [{ message: 'no identity' }] },
      { paging: { pageIndex: 2, pageSize: 50, total: 0 }, issues: [] },
    ]) {
      const provider = new SonarQualityProvider({ fetchImpl: async () => jsonResponse(200, payload) });
      await assert.rejects(provider.getIssues({ config: { baseUrl: BASE, projectKey: 'demo', authToken: TOKEN } }), QualityProviderError);
    }
  });
  it('preserves colon project keys and uses issue start line, not text range end line', async () => {
    const provider = new SonarQualityProvider({ fetchImpl: async () => jsonResponse(200, {
      total: 1, issues: [{ key: 'I1', component: 'group:demo:src/a.ts', rule: 'typescript:S1186',
        severity: 'CRITICAL', status: 'OPEN', message: 'Empty constructor', line: 9,
        textRange: { startLine: 9, endLine: 11 }, extraFutureField: true }],
    }) });
    const result = await provider.getIssues({ config: { baseUrl: BASE, projectKey: 'group:demo' } });
    assert.equal(result.issues[0].file, 'src/a.ts');
    assert.equal(result.issues[0].line, 9);
    assert.equal(result.issues[0].status, 'OPEN');
  });
  it('health online with version from /api/system/status', async () => {
    const fetchImpl: SonarFetch = async (input) => {
      const url = String(input);
      assert.ok(url.includes('/api/system/status'));
      return jsonResponse(200, {
        id: 'srv-1',
        version: '9.9.8.100196',
        status: 'UP',
      });
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const health = await provider.health({
      baseUrl: BASE,
      projectKey: 'demo',
      authToken: TOKEN,
    });
    assert.equal(health.online, true);
    assert.equal(health.version, '9.9.8.100196');
    assert.equal(health.connectionStatus, 'CONNECTED');
  });

  it('health offline on network error', async () => {
    const fetchImpl: SonarFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const health = await provider.health({
      baseUrl: BASE,
      projectKey: 'demo',
    });
    assert.equal(health.online, false);
    assert.equal(health.connectionStatus, 'SERVER_UNAVAILABLE');
  });

  it('health timeout maps to TIMEOUT', async () => {
    const fetchImpl: SonarFetch = async (_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    const provider = new SonarQualityProvider({
      fetchImpl,
      timeoutMs: 20,
    });
    const health = await provider.health({
      baseUrl: BASE,
      projectKey: 'demo',
    });
    assert.equal(health.connectionStatus, 'TIMEOUT');
  });

  it('testConnection: valid auth + project', async () => {
    const fetchImpl: SonarFetch = async (input, init) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      // Default authMode is basic-token (Sonar 9.9.8 authenticated APIs).
      assert.ok(auth?.startsWith('Basic '));
      assert.ok(!auth?.includes(TOKEN));
      if (url.includes('/api/system/status')) {
        return jsonResponse(200, {
          version: '9.9.8.100196',
          status: 'UP',
        });
      }
      if (url.includes('/api/projects/search')) {
        return jsonResponse(200, {
          components: [{ key: 'demo-key', name: 'Demo Project' }],
        });
      }
      return textResponse(404, 'no');
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const result = await provider.testConnection({
      baseUrl: BASE,
      projectKey: 'demo-key',
      authToken: TOKEN,
    });
    assert.equal(result.status, 'CONNECTED');
    assert.equal(result.authenticationConfigured, true);
    assert.equal(result.project?.key, 'demo-key');
    assert.equal(result.project?.name, 'Demo Project');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  it('uses Bearer when authMode=bearer', async () => {
    const fetchImpl: SonarFetch = async (_input, init) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      assert.equal(auth, `Bearer ${TOKEN}`);
      return jsonResponse(200, { version: '9.9.8', status: 'UP' });
    };
    const provider = new SonarQualityProvider({
      fetchImpl,
      authMode: 'bearer',
    });
    const health = await provider.health({
      baseUrl: BASE,
      projectKey: 'demo',
      authToken: TOKEN,
    });
    assert.equal(health.online, true);
  });

  it('createProject: creates via POST /api/projects/create', async () => {
    const calls: string[] = [];
    const fetchImpl: SonarFetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/api/projects/search')) {
        return jsonResponse(200, { components: [] });
      }
      if (url.includes('/api/projects/create')) {
        assert.equal(init?.method, 'POST');
        assert.ok(
          String(init?.headers && (init.headers as Record<string, string>)['Content-Type']).includes(
            'application/x-www-form-urlencoded',
          ),
        );
        assert.equal(init?.body, 'project=new-key&name=New+Name');
        return jsonResponse(200, {
          project: { key: 'new-key', name: 'New Name' },
        });
      }
      return textResponse(404, 'no');
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const result = await provider.createProject({
      config: { baseUrl: BASE, projectKey: 'new-key', authToken: TOKEN },
      projectName: 'New Name',
    });
    assert.equal(result.created, true);
    assert.equal(result.status, 'CONNECTED');
    assert.equal(result.project?.key, 'new-key');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  it('createProject: CREATE_FORBIDDEN on 403', async () => {
    const fetchImpl: SonarFetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/projects/search')) {
        return jsonResponse(200, { components: [] });
      }
      return textResponse(403, 'Forbidden');
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const result = await provider.createProject({
      config: { baseUrl: BASE, projectKey: 'x', authToken: TOKEN },
      projectName: 'X',
    });
    assert.equal(result.status, 'CREATE_FORBIDDEN');
    assert.equal(result.created, false);
  });

  it('ensureProject: missing + autoCreate false does not create', async () => {
    let createCalled = false;
    const fetchImpl: SonarFetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/system/status')) {
        return jsonResponse(200, { version: '9.9.8', status: 'UP' });
      }
      if (url.includes('/api/projects/create')) {
        createCalled = true;
        return jsonResponse(200, { project: { key: 'x', name: 'X' } });
      }
      return jsonResponse(200, { components: [] });
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const result = await provider.ensureProject({
      config: { baseUrl: BASE, projectKey: 'x', authToken: TOKEN },
      autoCreate: false,
    });
    assert.equal(result.status, 'PROJECT_NOT_FOUND');
    assert.equal(createCalled, false);
  });

  it('getAnalysisTask maps CE SUCCESS', async () => {
    const fetchImpl: SonarFetch = async (input) => {
      assert.ok(String(input).includes('/api/ce/task'));
      return jsonResponse(200, {
        task: {
          id: 'AY123',
          status: 'SUCCESS',
          analysisId: 'A1',
          submittedAt: '2024-01-01T00:00:00+0000',
        },
      });
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const task = await provider.getAnalysisTask({
      config: { baseUrl: BASE, projectKey: 'demo', authToken: TOKEN },
      taskId: 'AY123',
    });
    assert.equal(task?.taskId, 'AY123');
    assert.equal(task?.status, 'success');
    assert.equal(task?.analysisId, 'A1');
    assert.equal(task?.vendorStatus, 'SUCCESS');
  });

  it('getLatestAnalysisActivity uses /api/ce/activity', async () => {
    const fetchImpl: SonarFetch = async (input) => {
      const url = String(input);
      assert.ok(url.includes('/api/ce/activity'));
      assert.ok(url.includes('component=demo'));
      return jsonResponse(200, {
        tasks: [{ id: 'T1', status: 'IN_PROGRESS' }],
      });
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const task = await provider.getLatestAnalysisActivity({
      config: { baseUrl: BASE, projectKey: 'demo', authToken: TOKEN },
    });
    assert.equal(task?.taskId, 'T1');
    assert.equal(task?.status, 'in_progress');
  });

  it('testConnection: invalid auth', async () => {
    const fetchImpl: SonarFetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/system/status')) {
        return jsonResponse(200, { version: '9.9.8', status: 'UP' });
      }
      return textResponse(401, 'Unauthorized');
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const result = await provider.testConnection({
      baseUrl: BASE,
      projectKey: 'demo-key',
      authToken: TOKEN,
    });
    assert.equal(result.status, 'AUTHENTICATION_FAILED');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  it('testConnection: forbidden', async () => {
    const fetchImpl: SonarFetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/system/status')) {
        return jsonResponse(200, { version: '9.9.8', status: 'UP' });
      }
      return textResponse(403, 'Forbidden');
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const result = await provider.testConnection({
      baseUrl: BASE,
      projectKey: 'demo-key',
      authToken: TOKEN,
    });
    assert.equal(result.status, 'FORBIDDEN');
  });

  it('getProject: exists and missing', async () => {
    let includeProject = true;
    const fetchImpl: SonarFetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/system/status')) {
        return jsonResponse(200, { version: '9.9.8', status: 'UP' });
      }
      return jsonResponse(200, {
        components: includeProject
          ? [{ key: 'demo-key', name: 'Demo' }]
          : [],
      });
    };
    const provider = new SonarQualityProvider({ fetchImpl });
    const found = await provider.getProject({
      baseUrl: BASE,
      projectKey: 'demo-key',
      authToken: TOKEN,
    });
    assert.equal(found?.key, 'demo-key');
    includeProject = false;
    const missing = await provider.getProject({
      baseUrl: BASE,
      projectKey: 'demo-key',
      authToken: TOKEN,
    });
    assert.equal(missing, null);
  });

  it('getIssues: page 1, empty, multi-page, filters, mapping', async () => {
    const fetchImpl: SonarFetch = async (input) => {
      const url = new URL(String(input));
      assert.ok(url.pathname.endsWith('/api/issues/search'));
      const page = Number(url.searchParams.get('p') ?? '1');
      const pageSize = Number(url.searchParams.get('ps') ?? '50');
      if (url.searchParams.get('severities') === 'MAJOR') {
        return jsonResponse(200, {
          total: 1,
          paging: { pageIndex: 1, pageSize, total: 1 },
          issues: [
            {
              key: 'ISSUE-FILTERED',
              rule: 'java:S1',
              severity: 'MAJOR',
              type: 'CODE_SMELL',
              status: 'OPEN',
              message: 'Filtered',
              component: 'demo-key:src/A.java',
              line: 10,
              effort: '5min',
              tags: ['convention'],
              creationDate: '2024-01-01T00:00:00+0000',
              updateDate: '2024-01-02T00:00:00+0000',
            },
          ],
          facets: [
            {
              property: 'severities',
              values: [{ val: 'MAJOR', count: 1 }],
            },
          ],
        });
      }
      if (page === 2) {
        return jsonResponse(200, {
          paging: { pageIndex: 2, pageSize, total: 120 },
          issues: [
            {
              key: 'ISSUE-2',
              rule: 'java:S2',
              severity: 'MINOR',
              message: 'Page 2',
              component: 'demo-key:src/B.java',
              line: 2,
            },
          ],
          facets: [],
        });
      }
      if (url.searchParams.get('forceEmpty') === '1') {
        return jsonResponse(200, {
          total: 0,
          paging: { pageIndex: 1, pageSize, total: 0 },
          issues: [],
          facets: [],
        });
      }
      return jsonResponse(200, {
        paging: { pageIndex: 1, pageSize, total: 120 },
        issues: [
          {
            key: 'ISSUE-1',
            rule: 'java:S1',
            severity: 'BLOCKER',
            type: 'BUG',
            status: 'OPEN',
            message: 'Null deref',
            component: 'demo-key:src/A.java',
            line: 42,
            effort: '30min',
            tags: ['bug'],
          },
        ],
        facets: [
          {
            property: 'severities',
            values: [
              { val: 'BLOCKER', count: 3 },
              { val: 'MAJOR', count: 10 },
            ],
          },
          {
            property: 'types',
            values: [{ val: 'BUG', count: 5 }],
          },
        ],
      });
    };

    const provider = new SonarQualityProvider({ fetchImpl });
    const page1 = await provider.getIssues({
      config: { baseUrl: BASE, projectKey: 'demo-key', authToken: TOKEN },
      page: 1,
      pageSize: 50,
    });
    assert.equal(page1.page, 1);
    assert.equal(page1.total, 120);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.issues.length, 1);
    assert.equal(page1.issues[0].id, 'ISSUE-1');
    assert.equal(page1.issues[0].file, 'src/A.java');
    assert.equal(page1.issues[0].line, 42);
    assert.equal(page1.issues[0].severity, 'BLOCKER');
    assert.equal(page1.severityCounts?.BLOCKER, 3);
    assert.equal(page1.typeCounts?.BUG, 5);

    const page2 = await provider.getIssues({
      config: { baseUrl: BASE, projectKey: 'demo-key', authToken: TOKEN },
      page: 2,
      pageSize: 50,
    });
    assert.equal(page2.page, 2);
    assert.equal(page2.issues[0].id, 'ISSUE-2');
    assert.equal(page2.hasMore, true);

    const filtered = await provider.getIssues({
      config: { baseUrl: BASE, projectKey: 'demo-key', authToken: TOKEN },
      filters: { severity: 'MAJOR' },
    });
    assert.equal(filtered.issues[0].id, 'ISSUE-FILTERED');
  });

  it('getIssues: zero issues', async () => {
    const fetchImpl: SonarFetch = async () =>
      jsonResponse(200, {
        total: 0,
        paging: { pageIndex: 1, pageSize: 50, total: 0 },
        issues: [],
        facets: [],
      });
    const provider = new SonarQualityProvider({ fetchImpl });
    const result = await provider.getIssues({
      config: { baseUrl: BASE, projectKey: 'demo', authToken: TOKEN },
    });
    assert.equal(result.total, 0);
    assert.equal(result.issues.length, 0);
    assert.equal(result.hasMore, false);
  });

  it('getIssues: malformed response throws without leaking token', async () => {
    const fetchImpl: SonarFetch = async () =>
      textResponse(200, `not-json ${TOKEN}`);
    const provider = new SonarQualityProvider({ fetchImpl });
    await assert.rejects(
      () =>
        provider.getIssues({
          config: { baseUrl: BASE, projectKey: 'demo', authToken: TOKEN },
        }),
      (err: unknown) => {
        assert.ok(err instanceof QualityProviderError);
        assert.ok(!String(err).includes(TOKEN));
        return true;
      },
    );
  });

  it('does not include token in error messages from auth failures', async () => {
    const fetchImpl: SonarFetch = async () =>
      textResponse(401, `bad token was ${TOKEN}`);
    const provider = new SonarQualityProvider({ fetchImpl });
    const result = await provider.testConnection({
      baseUrl: BASE,
      projectKey: 'demo',
      authToken: TOKEN,
    });
    assert.equal(result.status, 'AUTHENTICATION_FAILED');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
});
