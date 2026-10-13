import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectSecretValues,
  isSecretEnvKey,
  redactSecretArgs,
  redactSecretsInEnv,
  redactSecretsInText,
} from './secrets';

describe('secrets redaction', () => {
  it('collects Sonar argv credentials even without an environment value', () => {
    const values = collectSecretValues({}, ['-Dsonar.login=abc', '-Dsonar.token=abcdef']);
    assert.equal(redactSecretsInText('abcdef abc', values), '[REDACTED] [REDACTED]');
    assert.deepEqual(redactSecretArgs(['-Dsonar.login=abc'], values), ['-Dsonar.login=[REDACTED]']);
  });
  it('detects secret-like env keys case-insensitively', () => {
    assert.equal(isSecretEnvKey('API_TOKEN'), true);
    assert.equal(isSecretEnvKey('dbPassword'), true);
    assert.equal(isSecretEnvKey('my_secret'), true);
    assert.equal(isSecretEnvKey('API_KEY'), true);
    assert.equal(isSecretEnvKey('Authorization'), true);
    assert.equal(isSecretEnvKey('NODE_ENV'), false);
  });

  it('redacts secret env values', () => {
    const redacted = redactSecretsInEnv({
      NODE_ENV: 'test',
      API_TOKEN: 'super-secret-token',
      PATH: '/usr/bin',
    });
    assert.equal(redacted.NODE_ENV, 'test');
    assert.equal(redacted.API_TOKEN, '[REDACTED]');
    assert.equal(redacted.PATH, '/usr/bin');
  });

  it('redacts known secret values in text', () => {
    const secrets = collectSecretValues({
      PASSWORD: 'hunter2xx',
      SAFE: 'visible',
    });
    const text = redactSecretsInText('login hunter2xx ok', secrets);
    assert.equal(text, 'login [REDACTED] ok');
  });

  it('redacts sonar token/login/password CLI args', () => {
    const args = redactSecretArgs(
      [
        '-Dsonar.projectKey=demo',
        '-Dsonar.token=super-secret-token-xyz',
        '-Dsonar.login=super-secret-token-xyz',
        '-Dsonar.password=hunter2xx',
        '-Dsonar.host.url=http://localhost:9000',
      ],
      ['super-secret-token-xyz', 'hunter2xx'],
    );
    assert.equal(args[0], '-Dsonar.projectKey=demo');
    assert.equal(args[1], '-Dsonar.token=[REDACTED]');
    assert.equal(args[2], '-Dsonar.login=[REDACTED]');
    assert.equal(args[3], '-Dsonar.password=[REDACTED]');
    assert.equal(args[4], '-Dsonar.host.url=http://localhost:9000');
  });
});
