import { Inject, Injectable } from '@nestjs/common';
import type {
  QualityIssue,
  QualityProviderConfig,
} from '@amp/core';
import type { IndexContextResult, ProjectIndexState, IndexerProvider } from '@amp/providers';
import { INDEXER_PROVIDER } from '../providers/tokens';
import { CodeContextService } from '../indexer/code-context.service';
import { ProjectIndexRepository } from '../persistence/project-index.repository';
import { ProjectRepository } from '../persistence/project.repository';

export interface QualityIssueContext {
  issue: QualityIssue;
  codeContext?: IndexContextResult;
  warnings: string[];
  indexState?: ProjectIndexState;
  indexProvider?: string;
}

/**
 * Bridges QualityIssue → CodeContextService → IndexerProvider.
 * Does NOT call SonarQualityProvider or know about Sonar APIs.
 */
@Injectable()
export class QualityIssueContextService {
  constructor(
    private readonly codeContext: CodeContextService,
    private readonly projects: ProjectRepository,
    private readonly indexes: ProjectIndexRepository,
    @Inject(INDEXER_PROVIDER) private readonly indexer?: IndexerProvider,
  ) {}

  async resolve(
    projectId: string,
    issue: QualityIssue,
  ): Promise<QualityIssueContext> {
    const warnings: string[] = [];
    const project = this.projects.findById(projectId);
    if (!project) {
      return {
        issue,
        warnings: ['Proyecto no encontrado.'],
      };
    }

    const index = this.indexes.findByProjectId(projectId);
    const indexState = this.indexer
      ? (await this.indexer.getProjectIndexStatus(projectId).catch(() => ({ state: index?.status }))).state
      : index?.status;

    if (indexState === 'stale') {
      warnings.push(
        'El índice de código está desactualizado. El contexto puede no coincidir con el código actual.',
      );
    }

    if (!issue.file) {
      warnings.push('No se pudo resolver el símbolo.');
      return { issue, warnings, indexState, indexProvider: this.indexer?.name };
    }

    // Prefer an explicit symbol only if the provider already gave one via rule/message heuristics.
    // We never invent a symbol name — query by file (+ line via getContext file param).
    const symbolHint = extractSymbolHint(issue);
    try {
      const codeContext = await this.codeContext.getContext({
        projectId,
        projectPath: project.path,
        providerProjectName: index?.providerProjectName ?? undefined,
        file: issue.file,
        line: issue.line,
        symbol: symbolHint,
        kind: symbolHint ? 'symbol' : undefined,
      });

      const hasMatch =
        Boolean(codeContext.target) ||
        codeContext.symbols.length > 0 ||
        codeContext.snippets.length > 0;

      if (!hasMatch) {
        warnings.push('No se pudo resolver el símbolo.');
      } else if (issue.line != null && codeContext.symbols.length > 0) {
        // Prefer symbol whose range covers the issue line when available.
        const covering = codeContext.symbols.filter(
          (s) =>
            s.startLine != null &&
            s.endLine != null &&
            issue.line != null &&
            s.startLine <= issue.line &&
            s.endLine >= issue.line,
        ).sort((a, b) => (a.endLine! - a.startLine!) - (b.endLine! - b.startLine!))[0];
        if (covering) {
          return {
            issue,
            codeContext: { ...codeContext, target: covering },
            warnings,
            indexState,
            indexProvider: this.indexer?.name,
          };
        }
      }

      return {
        issue,
        codeContext,
        warnings,
        indexState,
        indexProvider: this.indexer?.name,
      };
    } catch {
      warnings.push('No se pudo resolver el símbolo.');
      return { issue, warnings, indexState, indexProvider: this.indexer?.name };
    }
  }
}

/**
 * Only returns a hint when the message clearly names a symbol-like token.
 * Never fabricates identifiers from severity/rule alone.
 */
export function extractSymbolHint(issue: QualityIssue): string | undefined {
  // Conservative: do not guess. File+line resolution goes through indexer file query.
  void issue;
  return undefined;
}

/** Helper used by QualityService when building provider config. */
export type ResolvedQualityConfig = QualityProviderConfig & {
  authenticationConfigured: boolean;
  baseUrlSource: 'project' | 'global' | 'none';
};
