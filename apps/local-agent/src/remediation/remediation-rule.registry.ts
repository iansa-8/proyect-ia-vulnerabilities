import { Injectable } from '@nestjs/common';

export type RegisteredRemediationStrategy = 'local' | 'llm';

export interface RemediationRuleDefinition {
  rule: string;
  strategy: RegisteredRemediationStrategy;
  reason: string;
  /** True only when a deterministic patch can be produced and applied safely. */
  patchSupported?: boolean;
}

/**
 * Small, explicit Sonar rule registry. Adding a rule is intentionally a
 * code change so unsupported transformations cannot silently become agent work.
 */
@Injectable()
export class RemediationRuleRegistry {
  private readonly definitions = new Map<string, RemediationRuleDefinition>();

  constructor() {
    this.register({ rule: 'typescript:S1128', strategy: 'local', reason: 'La regla tiene una remediación local determinística.' });
    this.register({ rule: 'typescript:S1481', strategy: 'local', reason: 'La regla tiene una remediación local determinística.' });
    this.register({ rule: 'typescript:S1186', strategy: 'local', reason: 'La regla tiene una remediación local determinística.' });
    this.register({ rule: 'typescript:S4325', strategy: 'local', reason: 'La regla tiene una remediación local determinística.' });
    this.register({ rule: 'typescript:S2933', strategy: 'local', reason: 'La regla tiene una remediación local determinística con precondiciones.', patchSupported: true });
    this.register({ rule: 'typescript:S3776', strategy: 'llm', reason: 'Reducir complejidad requiere razonar sobre estructura y comportamiento.' });
  }

  register(definition: RemediationRuleDefinition): void {
    if (!definition.rule.trim() || !definition.reason.trim()) {
      throw new Error('REMEDIATION_RULE_INVALID');
    }
    this.definitions.set(definition.rule, { ...definition, rule: definition.rule.trim() });
  }

  get(rule: string): RemediationRuleDefinition | undefined {
    return this.definitions.get(rule);
  }
}
