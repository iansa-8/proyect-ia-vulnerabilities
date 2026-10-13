import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AgentExecutionTrace, AgentProposal } from '@amp/core';
import { SqliteService } from './sqlite.service';

export interface AgentProposalRecord extends AgentProposal {
  id: string;
  projectId: string;
  issueId: string;
  providerVersion?: string;
  createdAt: string;
  durationMs?: number;
  status: 'completed' | 'approved' | 'rejected';
  approvedAt?: string;
  approvedBy?: string;
  contextRevision?: string;
  contextFileHashes: Record<string, string>;
  contextFiles: string[];
  contextSizeChars: number;
  repositoryUnchanged: boolean;
  executionTrace?: AgentExecutionTrace;
  requiresAgent?: boolean;
  escalationReason?: string;
}

@Injectable()
export class AgentProposalRepository {
  constructor(private readonly sqlite: SqliteService) {}

  create(input: Omit<AgentProposalRecord, 'id' | 'createdAt' | 'status'>): AgentProposalRecord {
    const record: AgentProposalRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'completed',
    };
    this.sqlite.getDb().run(
      `INSERT INTO agent_proposals
       (id, project_id, issue_id, provider, provider_version, task_id, created_at,
        summary, diagnosis, affected_files_json, proposed_changes_json, patch_json,
        agent_suggested_risk, validation_plan_json, assumptions_json,
        warnings_json, duration_ms, status, context_files_json,
        context_size_chars, repository_unchanged, execution_trace_json,
        context_revision, context_file_hashes_json, approved_at, approved_by,
        remediation_strategy, remediation_reason, estimated_input_tokens,
        input_tokens, output_tokens, requires_agent, escalation_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.issueId,
        record.provider,
        record.providerVersion ?? null,
        record.taskId,
        record.createdAt,
        record.summary,
        record.diagnosis ?? null,
        JSON.stringify(record.affectedFiles),
        JSON.stringify(record.proposedChanges),
        record.patch ? JSON.stringify(record.patch) : null,
        record.agentSuggestedRisk,
        JSON.stringify(record.validationPlan),
        JSON.stringify(record.assumptions ?? []),
        JSON.stringify(record.warnings ?? []),
        record.durationMs ?? null,
        record.status,
        JSON.stringify(record.contextFiles),
        record.contextSizeChars,
        record.repositoryUnchanged ? 1 : 0,
        record.executionTrace ? JSON.stringify(record.executionTrace) : null,
        record.contextRevision ?? null,
        JSON.stringify(record.contextFileHashes ?? {}),
        record.approvedAt ?? null,
        record.approvedBy ?? null,
        record.remediationStrategy ?? null,
        record.remediationReason ?? null,
        record.estimatedInputTokens ?? null,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.requiresAgent ? 1 : 0,
        record.escalationReason ?? null,
      ],
    );
    this.sqlite.persist();
    return record;
  }

  findById(id: string): AgentProposalRecord | null {
    const stmt = this.sqlite.getDb().prepare('SELECT * FROM agent_proposals WHERE id = ?');
    stmt.bind([id]);
    if (!stmt.step()) { stmt.free(); return null; }
    const record = this.map(stmt.getAsObject());
    stmt.free();
    return record;
  }

  markApproved(id: string, approvedBy: string): AgentProposalRecord | null {
    // A rejected proposal is a terminal decision. Keep this guard in the
    // repository as well as in the pipeline step so callers cannot bypass the
    // state transition by invoking the repository directly.
    const current = this.findById(id);
    if (!current || current.status === 'rejected') return null;

    const approvedAt = new Date().toISOString();
    this.sqlite.getDb().run(
      `UPDATE agent_proposals SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ? AND status <> 'rejected'`,
      [approvedAt, approvedBy, id],
    );
    this.sqlite.persist();
    return this.findById(id);
  }

  markRejected(id: string): AgentProposalRecord | null {
    this.sqlite.getDb().run(`UPDATE agent_proposals SET status = 'rejected' WHERE id = ?`, [id]);
    this.sqlite.persist();
    return this.findById(id);
  }

  list(projectId: string, issueId?: string): AgentProposalRecord[] {
    const query = issueId
      ? 'SELECT * FROM agent_proposals WHERE project_id = ? AND issue_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM agent_proposals WHERE project_id = ? ORDER BY created_at DESC';
    const stmt = this.sqlite.getDb().prepare(query);
    stmt.bind(issueId ? [projectId, issueId] : [projectId]);
    const out: AgentProposalRecord[] = [];
    while (stmt.step()) out.push(this.map(stmt.getAsObject()));
    stmt.free();
    return out;
  }

  private map(row: Record<string, unknown>): AgentProposalRecord {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      issueId: String(row.issue_id),
      provider: String(row.provider),
      providerVersion: row.provider_version ? String(row.provider_version) : undefined,
      taskId: String(row.task_id),
      createdAt: String(row.created_at),
      summary: String(row.summary),
      diagnosis: row.diagnosis ? String(row.diagnosis) : undefined,
      affectedFiles: JSON.parse(String(row.affected_files_json)) as string[],
      proposedChanges: JSON.parse(String(row.proposed_changes_json)) as AgentProposal['proposedChanges'],
      patch: row.patch_json
        ? (JSON.parse(String(row.patch_json)) as AgentProposal['patch'])
        : undefined,
      agentSuggestedRisk: String(row.agent_suggested_risk) as AgentProposal['agentSuggestedRisk'],
      validationPlan: JSON.parse(String(row.validation_plan_json)) as string[],
      assumptions: JSON.parse(String(row.assumptions_json)) as string[],
      warnings: JSON.parse(String(row.warnings_json)) as string[],
      durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
      status: String(row.status) as AgentProposalRecord['status'],
      approvedAt: row.approved_at ? String(row.approved_at) : undefined,
      approvedBy: row.approved_by ? String(row.approved_by) : undefined,
      contextRevision: row.context_revision ? String(row.context_revision) : undefined,
      contextFileHashes: row.context_file_hashes_json
        ? (JSON.parse(String(row.context_file_hashes_json)) as Record<string, string>)
        : {},
      contextFiles: JSON.parse(String(row.context_files_json)) as string[],
      contextSizeChars: Number(row.context_size_chars),
      repositoryUnchanged: Number(row.repository_unchanged) === 1,
      executionTrace: row.execution_trace_json
        ? (JSON.parse(String(row.execution_trace_json)) as AgentExecutionTrace)
        : undefined,
      rawResponseAvailable: false,
      remediationStrategy: row.remediation_strategy
        ? String(row.remediation_strategy) as AgentProposal['remediationStrategy']
        : undefined,
      remediationReason: row.remediation_reason ? String(row.remediation_reason) : undefined,
      estimatedInputTokens: row.estimated_input_tokens == null ? undefined : Number(row.estimated_input_tokens),
      inputTokens: row.input_tokens == null ? undefined : Number(row.input_tokens),
      outputTokens: row.output_tokens == null ? undefined : Number(row.output_tokens),
      requiresAgent: row.requires_agent != null ? Number(row.requires_agent) === 1 : undefined,
      escalationReason: row.escalation_reason ? String(row.escalation_reason) : undefined,
    };
  }
}
