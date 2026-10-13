import { RemediationRuleRegistry } from './remediation-rule.registry';

describe('RemediationRuleRegistry', () => {
  it('contains only explicitly registered initial rules', () => {
    const registry = new RemediationRuleRegistry();

    expect(registry.get('typescript:S2933')).toMatchObject({ strategy: 'local', patchSupported: true });
    expect(registry.get('typescript:S3776')).toMatchObject({ strategy: 'llm' });
    expect(registry.get('typescript:S9999')).toBeUndefined();
  });

  it('allows a new rule to be registered without changing the router', () => {
    const registry = new RemediationRuleRegistry();
    registry.register({ rule: 'custom:rule', strategy: 'local', reason: 'Fixture rule' });

    expect(registry.get('custom:rule')?.strategy).toBe('local');
  });
});
