import { Module, forwardRef } from '@nestjs/common';
import { QualityAnalyzerRegistry } from '@amp/providers';
import { ExecutionModule } from '../execution/execution.module';
import { IndexerModule } from '../indexer/indexer.module';
import { QUALITY_ANALYZER_REGISTRY } from '../providers/tokens';
import { QualityController } from './quality.controller';
import { QualityService } from './quality.service';
import { QualityIssueContextService } from './quality-issue-context.service';
import { NodeSonarAnalyzer } from './node-sonar-analyzer';

@Module({
  imports: [ExecutionModule, forwardRef(() => IndexerModule)],
  controllers: [QualityController],
  providers: [
    QualityService,
    QualityIssueContextService,
    NodeSonarAnalyzer,
    {
      provide: QUALITY_ANALYZER_REGISTRY,
      useFactory: (nodeSonar: NodeSonarAnalyzer): QualityAnalyzerRegistry => {
        const registry = new QualityAnalyzerRegistry();
        registry.register(nodeSonar);
        return registry;
      },
      inject: [NodeSonarAnalyzer],
    },
  ],
  exports: [
    QualityService,
    QualityIssueContextService,
    NodeSonarAnalyzer,
    QUALITY_ANALYZER_REGISTRY,
  ],
})
export class QualityModule {}
