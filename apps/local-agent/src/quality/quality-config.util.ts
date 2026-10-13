import type { QualityProviderConfig } from '@amp/core';
import { loadConfig, type AppConfig } from '../config/app-config';
import type { ProjectQualityConfigRecord } from '../persistence/project-quality-config.repository';

/**
 * Resolves runtime QualityProviderConfig from env + optional per-project override.
 * Token comes only from SONAR_TOKEN env — never from SQLite.
 *
 * A per-project URL may select a different path on the configured Sonar server,
 * but it may not silently redirect the global token to another origin. Additional
 * trusted origins must be listed explicitly in SONAR_ALLOWED_ORIGINS.
 */
export function buildQualityProviderConfig(
  stored: ProjectQualityConfigRecord | null,
): QualityProviderConfig & { authenticationConfigured: boolean } {
  const app = loadConfig();
  const baseUrl = resolveSonarBaseUrl(stored, app);
  const authToken = app.quality.sonarToken || undefined;
  return {
    baseUrl,
    projectKey: stored?.projectKey ?? '',
    projectName: stored?.sonarProjectName ?? undefined,
    authToken,
    credentialRef: { source: 'env', ref: 'SONAR_TOKEN' },
    authenticationConfigured: Boolean(authToken),
  };
}

export function resolveSonarBaseUrl(
  stored: ProjectQualityConfigRecord | null,
  app: AppConfig = loadConfig(),
): string {
  const override = stored?.baseUrlOverride?.trim() ?? '';
  if (override) {
    assertSonarUrlAllowed(override, app);
    return override;
  }
  const globalUrl = app.quality.sonarUrl.trim();
  if (globalUrl) parseOrigin(globalUrl);
  return globalUrl;
}

/**
 * Fail closed before a request carrying SONAR_TOKEN can be sent to an
 * untrusted origin. The global SONAR_URL origin is trusted by default; extra
 * origins require SONAR_ALLOWED_ORIGINS.
 */
export function assertSonarUrlAllowed(
  rawUrl: string,
  app: AppConfig = loadConfig(),
): void {
  const value = rawUrl.trim();
  if (!value) return;

  const targetOrigin = parseOrigin(value);
  const allowedOrigins = new Set<string>();
  if (app.quality.sonarUrl.trim()) {
    allowedOrigins.add(parseOrigin(app.quality.sonarUrl));
  }
  for (const configuredOrigin of app.quality.sonarAllowedOrigins) {
    allowedOrigins.add(parseOrigin(configuredOrigin));
  }

  if (!allowedOrigins.has(targetOrigin)) {
    throw new Error('SONAR_URL_OVERRIDE_ORIGIN_NOT_ALLOWED');
  }
}

function parseOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('SONAR_URL_INVALID');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('SONAR_URL_PROTOCOL_NOT_ALLOWED');
  }
  if (parsed.username || parsed.password) {
    throw new Error('SONAR_URL_CREDENTIALS_NOT_ALLOWED');
  }
  return parsed.origin;
}
