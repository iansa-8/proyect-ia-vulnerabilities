import { isPipelineStepStatus, type PipelineStepStatus } from './pipeline';

export function mapStepStatus(value: string): PipelineStepStatus | null {
  return isPipelineStepStatus(value) ? value : null;
}

export function assertStepTransition(
  from: PipelineStepStatus,
  to: PipelineStepStatus,
): boolean {
  const allowed: Record<PipelineStepStatus, PipelineStepStatus[]> = {
    pending: ['running', 'skipped'],
    running: ['success', 'failed'],
    success: ['rolled_back'],
    failed: ['rolled_back'],
    skipped: [],
    rolled_back: [],
  };
  return allowed[from].includes(to);
}
