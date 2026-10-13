import type { AppConfig } from '../config/app-config';
import {
  assertSonarUrlAllowed,
  resolveSonarBaseUrl,
} from './quality-config.util';

function app(overrides: Partial<AppConfig['quality']> = {}): AppConfig {
  return {
    quality: {
      sonarUrl: 'https://sonar.example/base',
      sonarAllowedOrigins: [],
      ...overrides,
    },
  } as AppConfig;
}

describe('quality URL security policy', () => {
  it('allows an override on the global Sonar origin, including a different path', () => {
    expect(() => assertSonarUrlAllowed('https://sonar.example:443/another', app())).not.toThrow();
  });

  it('rejects an override that would send the token to another origin', () => {
    expect(() => assertSonarUrlAllowed('https://attacker.example/base', app())).toThrow(
      'SONAR_URL_OVERRIDE_ORIGIN_NOT_ALLOWED',
    );
  });

  it('allows an explicitly configured additional origin', () => {
    const config = app({ sonarAllowedOrigins: ['https://trusted.example'] });
    expect(() => assertSonarUrlAllowed('https://trusted.example/base', config)).not.toThrow();
  });

  it('fails closed when no trusted origin is configured', () => {
    const config = app({ sonarUrl: '' });
    expect(() => assertSonarUrlAllowed('https://sonar.example/base', config)).toThrow(
      'SONAR_URL_OVERRIDE_ORIGIN_NOT_ALLOWED',
    );
  });

  it('rejects unsafe URL schemes and embedded credentials', () => {
    const config = app({ sonarAllowedOrigins: ['https://sonar.example', 'https://user:pass@sonar.example'] });
    expect(() => assertSonarUrlAllowed('file:///tmp/sonar', config)).toThrow(
      'SONAR_URL_PROTOCOL_NOT_ALLOWED',
    );
    expect(() => assertSonarUrlAllowed('https://user:pass@sonar.example', config)).toThrow(
      'SONAR_URL_CREDENTIALS_NOT_ALLOWED',
    );
  });

  it('resolves a stored override only after validating its origin', () => {
    const stored = {
      projectId: 'p1',
      provider: 'sonar',
      projectKey: 'demo',
      sonarProjectName: null,
      autoCreateProject: false,
      baseUrlOverride: 'https://sonar.example/another',
      updatedAt: '',
    };
    expect(resolveSonarBaseUrl(stored, app())).toBe('https://sonar.example/another');
  });
});
