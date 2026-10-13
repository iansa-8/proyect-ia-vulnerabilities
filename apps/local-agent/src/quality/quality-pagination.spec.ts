import { QualityService } from './quality.service';
import type { GetQualityIssuesResult, QualityIssue } from '@amp/core';

describe('Complete issue download', () => {
  const saved = process.env.QUALITY_PAGE_SIZE;
  afterEach(() => { if (saved === undefined) delete process.env.QUALITY_PAGE_SIZE; else process.env.QUALITY_PAGE_SIZE = saved; });
  function issue(id: string): QualityIssue { return { id, provider: 'sonar', rule: 'ts:S1', severity: 'MAJOR', type: 'CODE_SMELL', message: 'message', file: 'src/a.ts' }; }
  function service(pages: Partial<GetQualityIssuesResult>[]) {
    const value = Object.create(QualityService.prototype) as QualityService;
    const getIssues = jest.fn().mockImplementation(async (_id, query) => ({
      page: query.page, pageSize: query.pageSize, hasMore: false, ...pages[query.page - 1],
    }));
    value.getIssues = getIssues;
    return { value, getIssues };
  }
  it.each([{ issues: [] }, { issues: [issue('one')] }])('downloads zero or one page', async ({ issues }) => {
    const { value, getIssues } = service([{ total: issues.length, issues }]);
    expect((await value.getAllIssues('p')).issues).toEqual(issues);
    expect(getIssues).toHaveBeenCalledTimes(1);
  });
  it('downloads all pages and calculates totals from the complete set', async () => {
    const { value, getIssues } = service([
      { total: 2, issues: [issue('1')], hasMore: true },
      { total: 2, issues: [issue('2')] },
    ]);
    const result = await value.getAllIssues('p');
    expect(result.total).toBe(2);
    expect(result.issues).toHaveLength(2);
    expect(result.severityCounts).toEqual({ MAJOR: 2 });
    expect(result.typeCounts).toEqual({ CODE_SMELL: 2 });
    expect(getIssues).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ total: 2, issues: [issue('1')] }],
    [{ total: 2, issues: [], hasMore: true }],
    [{ total: 2, issues: [issue('1')], hasMore: true }, { total: 2, issues: [issue('1')] }],
    [{ total: 2, issues: [issue('1')], hasMore: true }, { total: 3, issues: [issue('2')] }],
    [{ total: -1, issues: [] }],
    [{ total: 0, issues: null }],
  ])('rejects incomplete or malformed pages %#', async (...pages) => {
    const { value } = service(pages as Partial<GetQualityIssuesResult>[]);
    await expect(value.getAllIssues('p')).rejects.toThrow();
  });
});
