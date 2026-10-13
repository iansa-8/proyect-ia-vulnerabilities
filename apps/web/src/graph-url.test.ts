import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGraphUrl } from './graph-url';

describe('buildGraphUrl', () => {
  it('returns stats tab when providerProjectName is missing', () => {
    assert.equal(
      buildGraphUrl('http://localhost:9749'),
      'http://localhost:9749/?tab=stats',
    );
    assert.equal(
      buildGraphUrl('http://localhost:9749', undefined),
      'http://localhost:9749/?tab=stats',
    );
    assert.equal(
      buildGraphUrl('http://localhost:9749', ''),
      'http://localhost:9749/?tab=stats',
    );
    assert.equal(
      buildGraphUrl('http://localhost:9749', '   '),
      'http://localhost:9749/?tab=stats',
    );
  });

  it('normalizes trailing slashes on baseUrl', () => {
    assert.equal(
      buildGraphUrl('http://localhost:9749/', undefined),
      'http://localhost:9749/?tab=stats',
    );
    assert.equal(
      buildGraphUrl('http://localhost:9749///', 'demo'),
      'http://localhost:9749/?tab=graph&project=demo',
    );
  });

  it('returns graph tab with encoded providerProjectName', () => {
    const name =
      'C-Users-20120902-1-OneDrive-laaraucana.cl-Documentos-repositorios-nom-cred-notification-credit';
    assert.equal(
      buildGraphUrl('http://localhost:9749', name),
      `http://localhost:9749/?tab=graph&project=${encodeURIComponent(name)}`,
    );
  });

  it('encodes special characters in providerProjectName', () => {
    const name = 'proyecto con espacios & ? áéí';
    assert.equal(
      buildGraphUrl('http://localhost:9749', name),
      `http://localhost:9749/?tab=graph&project=${encodeURIComponent(name)}`,
    );
    assert.match(
      buildGraphUrl('http://localhost:9749', name),
      /project=proyecto%20con%20espacios%20%26%20%3F%20/,
    );
  });
});
