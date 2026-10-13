import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  IndexContextResult,
  IndexerHealth,
  IndexerProvider,
  ProjectIndexStatus,
} from '@amp/providers';
import { INDEXER_PROVIDER } from '../providers/tokens';
import { ProjectRepository } from '../persistence/project.repository';
import { CodeContextService } from './code-context.service';
import { PipelineService } from '../pipeline/pipeline.service';
import type { PipelineRunView } from '../pipeline/pipeline.service';

export interface IndexContextRequestBody {
  symbol?: string;
  file?: string;
}

@Injectable()
export class IndexerService {
  constructor(
    @Inject(INDEXER_PROVIDER) private readonly indexer: IndexerProvider,
    private readonly projects: ProjectRepository,
    private readonly codeContext: CodeContextService,
    private readonly pipelines: PipelineService,
  ) {}

  async health(): Promise<IndexerHealth> {
    try {
      return await this.indexer.health();
    } catch (err: unknown) {
      return {
        provider: this.indexer.name,
        cliAvailable: false,
        uiAvailable: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getProjectIndex(projectId: string): Promise<ProjectIndexStatus> {
    const project = this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
    return this.indexer.getProjectIndexStatus(projectId);
  }

  /**
   * Semantic "Index Project" — runs the project-indexing pipeline (traced in SQLite).
   * Never accepts arbitrary shell command/args from the client.
   */
  async startIndex(
    projectId: string,
    forceReindex = false,
  ): Promise<PipelineRunView> {
    const project = this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
    if (!project.profile) {
      throw new BadRequestException(
        'Project has no persisted profile — select/analyze it first',
      );
    }
    return this.pipelines.startRun('project-indexing', projectId, {
      forceReindex,
    });
  }

  async getContext(
    projectId: string,
    body: IndexContextRequestBody,
  ): Promise<IndexContextResult> {
    const project = this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
    if (!body.symbol?.trim()) {
      throw new BadRequestException('symbol is required');
    }

    const status = await this.indexer.getProjectIndexStatus(projectId);
    return this.codeContext.getContext({
      projectId: project.id,
      projectPath: project.path,
      providerProjectName: status.providerProjectName,
      symbol: body.symbol.trim(),
      file: body.file?.trim() || undefined,
      kind: 'symbol',
    });
  }
}
