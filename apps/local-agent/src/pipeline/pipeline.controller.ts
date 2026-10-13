import {
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import type { AgentProvider, LLMProvider } from '@amp/providers';
import { AGENT_PROVIDER, LLM_PROVIDER } from '../providers/tokens';
import { AgentProposalRepository } from '../persistence/agent-proposal.repository';
import { FixApplicationRepository } from '../persistence/fix-application.repository';
import { PipelineService } from './pipeline.service';
import { BulkProposalService } from '../remediation/bulk-proposal.service';

class StartPipelineRunDto {
  @IsString()
  @IsNotEmpty()
  @IsUUID()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  issueId?: string;
}

class ApplyFixDto {
  @IsString()
  @IsNotEmpty()
  approvedBy!: string;

  @IsBoolean()
  @IsOptional()
  forceAgent?: boolean;
}

class ProposeFixDto {
  @IsBoolean()
  @IsOptional()
  forceAI?: boolean;
}

class BulkProposeFixDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  issueIds!: string[];
}

@Controller()
export class PipelineController {
  constructor(
    private readonly pipelineService: PipelineService,
    private readonly proposals: AgentProposalRepository,
    private readonly fixApplications: FixApplicationRepository,
    private readonly bulkProposals: BulkProposalService,
    @Inject(AGENT_PROVIDER) private readonly agent: AgentProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
  ) {}

  @Get('pipelines')
  listPipelines() {
    return this.pipelineService.listDefinitions();
  }

  @Post('pipelines/:pipelineId/runs')
  startRun(
    @Param('pipelineId') pipelineId: string,
    @Body() dto: StartPipelineRunDto,
  ) {
    return this.pipelineService.startRun(pipelineId, dto.projectId, {
      issueId: dto.issueId,
    });
  }

  @Post('projects/:projectId/quality/issues/:issueId/proposals/:proposalId/apply')
  applyFix(
    @Param('projectId') projectId: string,
    @Param('issueId') issueId: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: ApplyFixDto,
  ) {
    const proposal = this.proposals.findById(proposalId);
    if (!proposal || proposal.projectId !== projectId || proposal.issueId !== issueId) {
      throw new NotFoundException('Proposal not found for this issue');
    }
    if (proposal.status === 'rejected') {
      throw new ConflictException('Rejected proposal cannot be applied');
    }
    return this.pipelineService.startRun('quality-fix-application', projectId, {
      issueId, proposalId, approvedBy: dto.approvedBy, forceAgent: dto.forceAgent,
    });
  }

  @Post('projects/:projectId/quality/issues/:issueId/proposals/:proposalId/reject')
  rejectFix(
    @Param('projectId') projectId: string,
    @Param('issueId') issueId: string,
    @Param('proposalId') proposalId: string,
  ) {
    const proposal = this.proposals.findById(proposalId);
    if (!proposal || proposal.projectId !== projectId || proposal.issueId !== issueId) {
      throw new NotFoundException('Proposal not found for this issue');
    }
    return this.proposals.markRejected(proposalId);
  }

  @Get('projects/:projectId/quality/issues/:issueId/proposals/:proposalId/applications')
  listFixApplications(
    @Param('projectId') projectId: string,
    @Param('issueId') issueId: string,
    @Param('proposalId') proposalId: string,
  ) {
    const proposal = this.proposals.findById(proposalId);
    if (!proposal || proposal.projectId !== projectId || proposal.issueId !== issueId) {
      throw new NotFoundException('Proposal not found for this issue');
    }
    return this.fixApplications.listByProposalId(proposalId);
  }

  @Get('agent/health')
  agentHealth() {
    return this.agent.health();
  }

  @Get('llm/health')
  llmHealth() {
    return this.llm.health();
  }

  @Post('projects/:projectId/quality/issues/:issueId/proposals')
  proposeFix(
    @Param('projectId') projectId: string,
    @Param('issueId') issueId: string,
    @Body() dto: ProposeFixDto = {},
  ) {
    const existing = this.proposals.list(projectId, issueId)
      .find((proposal) => (proposal.status === 'completed' || proposal.status === 'approved')
        && Boolean(proposal.contextRevision)
        && Object.keys(proposal.contextFileHashes ?? {}).length > 0);
    if (existing) {
      throw new ConflictException(`El hallazgo ya tiene una propuesta vigente: ${existing.id}`);
    }
    return this.pipelineService.startRun('quality-fix-proposal', projectId, {
      issueId,
      forceAI: dto?.forceAI,
    });
  }

  @Post('projects/:projectId/quality/issues/bulk-proposals')
  proposeFixesInBulk(
    @Param('projectId') projectId: string,
    @Body() dto: BulkProposeFixDto,
  ) {
    return this.bulkProposals.propose(projectId, dto.issueIds);
  }

  @Get('projects/:projectId/quality/issues/:issueId/proposals')
  listProposals(
    @Param('projectId') projectId: string,
    @Param('issueId') issueId: string,
  ) {
    return this.proposals.list(projectId, issueId);
  }

  @Get('projects/:projectId/quality/proposals')
  listProjectProposals(@Param('projectId') projectId: string) {
    return this.proposals.list(projectId);
  }

  @Get('pipeline-runs/:runId')
  getRun(@Param('runId') runId: string) {
    return this.pipelineService.getRun(runId);
  }

  @Get('pipeline-runs')
  listRuns() {
    return this.pipelineService.listRuns();
  }
}
