import { Global, Module, forwardRef } from '@nestjs/common';
import {
  InMemoryIndexerProvider,
  SonarQualityProvider,
} from '@amp/providers';
import { SequentialPipelineEngine } from '@amp/pipeline';
import {
  AGENT_PROVIDER,
  LLM_PROVIDER,
  INDEXER_PROVIDER,
  PIPELINE_ENGINE,
  QUALITY_PROVIDER,
} from './tokens';
import { PIPELINE_DEFINITIONS } from '../pipeline/pipeline-definitions';
import { LoadProjectStep } from '../pipeline/steps/load-project.step';
import { ValidateDirectoryStep } from '../pipeline/steps/validate-directory.step';
import { CompleteStep } from '../pipeline/steps/complete.step';
import { CheckIndexerStep } from '../pipeline/steps/check-indexer.step';
import { IndexProjectStep } from '../pipeline/steps/index-project.step';
import { CheckCodeIndexStep } from '../pipeline/steps/check-code-index.step';
import { CheckQualityProviderStep } from '../pipeline/steps/check-quality-provider.step';
import { EnsureQualityProjectStep } from '../pipeline/steps/ensure-quality-project.step';
import { CheckQualityAnalyzerStep } from '../pipeline/steps/check-quality-analyzer.step';
import { RunQualityAnalysisStep } from '../pipeline/steps/run-quality-analysis.step';
import { WaitForQualityProcessingStep } from '../pipeline/steps/wait-quality-processing.step';
import { DownloadQualityIssuesStep } from '../pipeline/steps/download-quality-issues.step';
import { CreateQualitySnapshotStep } from '../pipeline/steps/create-quality-snapshot.step';
import { CodebaseMemoryIndexerProvider } from '../indexer/codebase-memory-indexer.provider';
import { loadConfig } from '../config/app-config';
import { ExecutionModule } from '../execution/execution.module';
import { EventsModule } from '../events/events.module';
import { QualityModule } from '../quality/quality.module';
import { CodexAgentProvider } from '../agent/codex-agent.provider';
import { OpenCodeAgentProvider } from '../agent/opencode-agent.provider';
import { ProposeFixPromptBuilder } from '../agent/propose-fix-prompt.builder';
import { BulkProposeFixPromptBuilder } from '../agent/bulk-propose-fix-prompt.builder';
import { WorkingTreeGuardService } from '../agent/working-tree-guard.service';
import { GitSafetyService } from '../agent/git-safety.service';
import { ApplyFixPromptBuilder } from '../agent/apply-fix-prompt.builder';
import { LoadQualityIssueStep } from '../pipeline/steps/load-quality-issue.step';
import { ResolveQualityContextStep } from '../pipeline/steps/resolve-quality-context.step';
import { CheckAgentProviderStep } from '../pipeline/steps/check-agent-provider.step';
import { CaptureWorkingTreeBaselineStep } from '../pipeline/steps/capture-working-tree-baseline.step';
import { ProposeFixStep } from '../pipeline/steps/propose-fix.step';
import { VerifyRepositoryUnchangedStep } from '../pipeline/steps/verify-repository-unchanged.step';
import { PersistAgentProposalStep } from '../pipeline/steps/persist-agent-proposal.step';
import {
  ApplyApprovedFixStep, CaptureGitBaselineStep, CaptureRunChangesStep,
  CheckApplyAgentProviderStep, CompareQualitySnapshotsStep,
  GenerateFixApplicationReportStep, LoadApprovedProposalStep,
  ValidateApprovedProposalStep, ValidateChangeScopeStep,
} from '../pipeline/steps/quality-fix-application.steps';
import {
  ApplyBulkApprovedFixesStep,
  CheckBulkApplyAgentProviderStep,
  CompareBulkQualitySnapshotsStep,
  LoadBulkApprovedProposalsStep,
  ValidateBulkApprovedProposalsStep,
} from '../pipeline/steps/bulk-fix-application.steps';
import {
  BuildValidationStep, E2EValidationStep, HealthValidationStep,
  StartupValidationStep, UnitValidationStep,
} from '../pipeline/steps/fix-validation.steps';
import { ValidationRunnerService } from '../validation/validation-runner.service';
import { ValidationPlanBuilder } from '../validation/validation-plan-builder.service';
import { LiteLLMProvider } from '../llm/litellm.provider';
import { RemediationRouter } from '../remediation/remediation-router.service';
import { IssueContextPolicy } from '../remediation/issue-context-policy.service';
import { DeterministicRemediator } from '../remediation/deterministic-remediator.service';
import { StructuredPatchEngine } from '../remediation/structured-patch.engine';
import { PatchValidator } from '../remediation/patch-validator.service';
import { RemediationRuleRegistry } from '../remediation/remediation-rule.registry';
import { BulkProposalService } from '../remediation/bulk-proposal.service';

function createPipelineEngine(
  loadProject: LoadProjectStep,
  validateDirectory: ValidateDirectoryStep,
  complete: CompleteStep,
  checkIndexer: CheckIndexerStep,
  indexProject: IndexProjectStep,
  checkCodeIndex: CheckCodeIndexStep,
  checkQualityProvider: CheckQualityProviderStep,
  ensureQualityProject: EnsureQualityProjectStep,
  checkQualityAnalyzer: CheckQualityAnalyzerStep,
  runQualityAnalysis: RunQualityAnalysisStep,
  waitQualityProcessing: WaitForQualityProcessingStep,
  downloadQualityIssues: DownloadQualityIssuesStep,
  createQualitySnapshot: CreateQualitySnapshotStep,
  loadQualityIssue: LoadQualityIssueStep,
  resolveQualityContext: ResolveQualityContextStep,
  checkAgentProvider: CheckAgentProviderStep,
  captureWorkingTreeBaseline: CaptureWorkingTreeBaselineStep,
  proposeFix: ProposeFixStep,
  verifyRepositoryUnchanged: VerifyRepositoryUnchangedStep,
  persistAgentProposal: PersistAgentProposalStep,
  loadApprovedProposal: LoadApprovedProposalStep,
  validateApprovedProposal: ValidateApprovedProposalStep,
  captureGitBaseline: CaptureGitBaselineStep,
  checkApplyAgentProvider: CheckApplyAgentProviderStep,
  applyApprovedFix: ApplyApprovedFixStep,
  captureRunChanges: CaptureRunChangesStep,
  validateChangeScope: ValidateChangeScopeStep,
  buildValidation: BuildValidationStep,
  unitValidation: UnitValidationStep,
  e2eValidation: E2EValidationStep,
  startupValidation: StartupValidationStep,
  healthValidation: HealthValidationStep,
  compareQualitySnapshots: CompareQualitySnapshotsStep,
  generateFixReport: GenerateFixApplicationReportStep,
  loadBulkApprovedProposals: LoadBulkApprovedProposalsStep,
  validateBulkApprovedProposals: ValidateBulkApprovedProposalsStep,
  checkBulkApplyAgentProvider: CheckBulkApplyAgentProviderStep,
  applyBulkApprovedFixes: ApplyBulkApprovedFixesStep,
  compareBulkQualitySnapshots: CompareBulkQualitySnapshotsStep,
): SequentialPipelineEngine {
  const engine = new SequentialPipelineEngine();
  engine.registerStep(loadProject);
  engine.registerStep(validateDirectory);
  engine.registerStep(complete);
  engine.registerStep(checkIndexer);
  engine.registerStep(indexProject);
  engine.registerStep(checkCodeIndex);
  engine.registerStep(checkQualityProvider);
  engine.registerStep(ensureQualityProject);
  engine.registerStep(checkQualityAnalyzer);
  engine.registerStep(runQualityAnalysis);
  engine.registerStep(waitQualityProcessing);
  engine.registerStep(downloadQualityIssues);
  engine.registerStep(createQualitySnapshot);
  engine.registerStep(loadQualityIssue);
  engine.registerStep(resolveQualityContext);
  engine.registerStep(checkAgentProvider);
  engine.registerStep(captureWorkingTreeBaseline);
  engine.registerStep(proposeFix);
  engine.registerStep(verifyRepositoryUnchanged);
  engine.registerStep(persistAgentProposal);
  engine.registerStep(loadApprovedProposal);
  engine.registerStep(validateApprovedProposal);
  engine.registerStep(captureGitBaseline);
  engine.registerStep(checkApplyAgentProvider);
  engine.registerStep(applyApprovedFix);
  engine.registerStep(captureRunChanges);
  engine.registerStep(validateChangeScope);
  engine.registerStep(buildValidation);
  engine.registerStep(unitValidation);
  engine.registerStep(e2eValidation);
  engine.registerStep(startupValidation);
  engine.registerStep(healthValidation);
  engine.registerStep(compareQualitySnapshots);
  engine.registerStep(generateFixReport);
  engine.registerStep(loadBulkApprovedProposals);
  engine.registerStep(validateBulkApprovedProposals);
  engine.registerStep(checkBulkApplyAgentProvider);
  engine.registerStep(applyBulkApprovedFixes);
  engine.registerStep(compareBulkQualitySnapshots);
  for (const definition of PIPELINE_DEFINITIONS) {
    engine.registerDefinition(definition);
  }
  return engine;
}

@Global()
@Module({
  imports: [ExecutionModule, EventsModule, forwardRef(() => QualityModule)],
  providers: [
    LoadProjectStep,
    ValidateDirectoryStep,
    CompleteStep,
    CheckIndexerStep,
    IndexProjectStep,
    CheckCodeIndexStep,
    CheckQualityProviderStep,
    EnsureQualityProjectStep,
    CheckQualityAnalyzerStep,
    RunQualityAnalysisStep,
    WaitForQualityProcessingStep,
    DownloadQualityIssuesStep,
    CreateQualitySnapshotStep,
    LoadQualityIssueStep,
    ResolveQualityContextStep,
    CheckAgentProviderStep,
    CaptureWorkingTreeBaselineStep,
    ProposeFixStep,
    VerifyRepositoryUnchangedStep,
    PersistAgentProposalStep,
    LoadApprovedProposalStep,
    ValidateApprovedProposalStep,
    CaptureGitBaselineStep,
    CheckApplyAgentProviderStep,
    ApplyApprovedFixStep,
    CaptureRunChangesStep,
    ValidateChangeScopeStep,
    BuildValidationStep,
    UnitValidationStep,
    E2EValidationStep,
    StartupValidationStep,
    HealthValidationStep,
    CompareQualitySnapshotsStep,
    GenerateFixApplicationReportStep,
    LoadBulkApprovedProposalsStep,
    ValidateBulkApprovedProposalsStep,
    CheckBulkApplyAgentProviderStep,
    ApplyBulkApprovedFixesStep,
    CompareBulkQualitySnapshotsStep,
    CodebaseMemoryIndexerProvider,
    ProposeFixPromptBuilder,
    BulkProposeFixPromptBuilder,
    BulkProposalService,
    RemediationRouter,
     RemediationRuleRegistry,
    IssueContextPolicy,
    DeterministicRemediator,
    StructuredPatchEngine,
    PatchValidator,
    LiteLLMProvider,
    ApplyFixPromptBuilder,
    GitSafetyService,
    ValidationRunnerService,
    ValidationPlanBuilder,
    WorkingTreeGuardService,
    CodexAgentProvider,
    OpenCodeAgentProvider,
    {
      provide: AGENT_PROVIDER,
      useFactory: (codex: CodexAgentProvider, opencode: OpenCodeAgentProvider) => {
        const provider = loadConfig().agent.provider;
        return provider === 'opencode' ? opencode : codex;
      },
      inject: [CodexAgentProvider, OpenCodeAgentProvider],
    },
    { provide: LLM_PROVIDER, useExisting: LiteLLMProvider },
    {
      provide: INDEXER_PROVIDER,
      useFactory: (
        codebaseMemory: CodebaseMemoryIndexerProvider,
      ): typeof codebaseMemory | InMemoryIndexerProvider => {
        const provider = loadConfig().indexer.provider;
        if (provider === 'codebase-memory') {
          return codebaseMemory;
        }
        return new InMemoryIndexerProvider();
      },
      inject: [CodebaseMemoryIndexerProvider],
    },
    {
      provide: QUALITY_PROVIDER,
      useFactory: (): SonarQualityProvider => {
        const mode = loadConfig().quality.sonarAuthMode;
        return new SonarQualityProvider({ authMode: mode });
      },
    },
    {
      provide: PIPELINE_ENGINE,
      useFactory: createPipelineEngine,
      inject: [
        LoadProjectStep,
        ValidateDirectoryStep,
        CompleteStep,
        CheckIndexerStep,
        IndexProjectStep,
        CheckCodeIndexStep,
        CheckQualityProviderStep,
        EnsureQualityProjectStep,
        CheckQualityAnalyzerStep,
        RunQualityAnalysisStep,
        WaitForQualityProcessingStep,
        DownloadQualityIssuesStep,
        CreateQualitySnapshotStep,
        LoadQualityIssueStep,
        ResolveQualityContextStep,
        CheckAgentProviderStep,
        CaptureWorkingTreeBaselineStep,
        ProposeFixStep,
        VerifyRepositoryUnchangedStep,
        PersistAgentProposalStep,
        LoadApprovedProposalStep,
        ValidateApprovedProposalStep,
        CaptureGitBaselineStep,
        CheckApplyAgentProviderStep,
        ApplyApprovedFixStep,
        CaptureRunChangesStep,
        ValidateChangeScopeStep,
        BuildValidationStep,
        UnitValidationStep,
        E2EValidationStep,
        StartupValidationStep,
        HealthValidationStep,
        CompareQualitySnapshotsStep,
        GenerateFixApplicationReportStep,
        LoadBulkApprovedProposalsStep,
        ValidateBulkApprovedProposalsStep,
        CheckBulkApplyAgentProviderStep,
        ApplyBulkApprovedFixesStep,
        CompareBulkQualitySnapshotsStep,
      ],
    },
  ],
  exports: [
    AGENT_PROVIDER,
    LLM_PROVIDER,
    INDEXER_PROVIDER,
    QUALITY_PROVIDER,
    PIPELINE_ENGINE,
    CodebaseMemoryIndexerProvider,
    QualityModule,
    CodexAgentProvider,
    OpenCodeAgentProvider,
    LiteLLMProvider,
    BulkProposalService,
    WorkingTreeGuardService,
    GitSafetyService,
  ],
})
export class ProvidersModule {}
