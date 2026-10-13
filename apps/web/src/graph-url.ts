/**
 * Builds the Codebase Memory UI URL for graph or stats.
 * Embedded graph is not implemented because Codebase Memory prevents
 * cross-origin framing (`Content-Security-Policy: frame-ancestors 'none'`).
 */
export function buildGraphUrl(
  baseUrl: string,
  providerProjectName?: string,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const name = providerProjectName?.trim();
  if (!name) {
    return `${base}/?tab=stats`;
  }
  return `${base}/?tab=graph&project=${encodeURIComponent(name)}`;
}
