import { Global, Module } from '@nestjs/common';
import { SqliteService } from './sqlite.service';
import { ProjectRepository } from './project.repository';
import { PipelineRunRepository } from './pipeline-run.repository';
import { ProjectIndexRepository } from './project-index.repository';
import { ProjectQualityConfigRepository } from './project-quality-config.repository';
import { QualitySnapshotRepository } from './quality-snapshot.repository';
import { AgentProposalRepository } from './agent-proposal.repository';
import { FixApplicationRepository } from './fix-application.repository';

@Global()
@Module({
  providers: [
    SqliteService,
    ProjectRepository,
    PipelineRunRepository,
    ProjectIndexRepository,
    ProjectQualityConfigRepository,
    QualitySnapshotRepository,
    AgentProposalRepository,
    FixApplicationRepository,
  ],
  exports: [
    SqliteService,
    ProjectRepository,
    PipelineRunRepository,
    ProjectIndexRepository,
    ProjectQualityConfigRepository,
    QualitySnapshotRepository,
    AgentProposalRepository,
    FixApplicationRepository,
  ],
})
export class PersistenceModule {}
