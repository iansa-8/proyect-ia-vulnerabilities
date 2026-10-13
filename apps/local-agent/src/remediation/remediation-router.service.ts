import { Injectable, Logger } from '@nestjs/common';
import type { RemediationDecision, RemediationInput } from '@amp/core';
import { RemediationRuleRegistry } from './remediation-rule.registry';

@Injectable()
export class RemediationRouter {
  private readonly logger = new Logger(RemediationRouter.name);
  constructor(private readonly rules: RemediationRuleRegistry = new RemediationRuleRegistry()) {}

  decide(input: RemediationInput): RemediationDecision {
    const snippets = input.context.snippets ?? [];
    this.logger.debug(`[RemediationRouter] Routing for rule=${input.issue.rule} file=${input.issue.file} snippets=${snippets.length}`);
    
    if (!input.issue.file || snippets.length === 0) {
      this.logger.warn('[RemediationRouter] No file or snippets -> manual');
      return {
        strategy: 'manual',
        reason: 'No hay código relevante suficiente para generar una propuesta segura.',
        confidence: 1,
      };
    }

    const registered = this.rules.get(input.issue.rule);
    if (registered) {
      this.logger.log(`[RemediationRouter] Rule ${input.issue.rule} -> ${registered.strategy} (${registered.reason})`);
      return {
        strategy: registered.strategy,
        reason: registered.reason,
        confidence: registered.strategy === 'local' ? 0.95 : 0.9,
      };
    }

    this.logger.log(`[RemediationRouter] Rule ${input.issue.rule} not registered -> llm`);
    return {
      strategy: 'llm',
      reason: 'Existe contexto de código, pero la regla no tiene una remediación local registrada.',
      confidence: 0.7,
    };
  }
}
