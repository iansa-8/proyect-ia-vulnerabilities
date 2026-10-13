export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface PolicyContext {
  action: string;
  projectPath: string;
  metadata?: Record<string, unknown>;
}

/** Future policy gate. Phase 1: interface only. */
export interface PolicyEngine {
  evaluate(context: PolicyContext): Promise<PolicyDecision>;
}
