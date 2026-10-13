export type SecurityFindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SecurityFinding {
  id: string;
  title: string;
  severity: SecurityFindingSeverity;
  packageName?: string;
  file?: string;
}

/**
 * Future security scanner. No npm audit / NuGet / Trivy implementation in Phase 1.
 */
export interface SecurityScanner {
  readonly name: string;
  scan(projectPath: string): Promise<SecurityFinding[]>;
}
