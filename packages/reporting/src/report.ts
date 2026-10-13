export interface ReportSection {
  id: string;
  title: string;
  body: string;
}

export interface ModernizationReport {
  id: string;
  projectId: string;
  createdAt: string;
  sections: ReportSection[];
}

/** Future report writer. No full JSON reporting in Phase 1. */
export interface ReportWriter {
  write(report: ModernizationReport): Promise<void>;
}
