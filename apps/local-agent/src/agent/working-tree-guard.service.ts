import { Injectable } from '@nestjs/common';
import { GitSafetyService } from './git-safety.service';

export interface WorkingTreeSnapshot {
  fingerprint: string;
  status: string;
  trackedDiff: string;
  stagedDiff: string;
  fileHashes?: Record<string, string>;
  fileContents?: Record<string, string>;
  /** Legacy test compatibility; GitSafetySnapshot supersedes this map. */
  untracked?: Record<string, string>;
}

@Injectable()
export class WorkingTreeGuardService {
  constructor(private readonly safety: GitSafetyService) {}

  async capture(projectPath: string): Promise<WorkingTreeSnapshot> {
    return this.safety.capture(projectPath);
  }

  unchanged(before: WorkingTreeSnapshot, after: WorkingTreeSnapshot): boolean {
    return before.fingerprint === after.fingerprint;
  }
}
