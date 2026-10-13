import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { EventsModule } from './events/events.module';
import { PersistenceModule } from './persistence/persistence.module';
import { ProjectModule } from './project/project.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { ProvidersModule } from './providers/providers.module';
import { ExecutionModule } from './execution/execution.module';
import { IndexerModule } from './indexer/indexer.module';
import { QualityModule } from './quality/quality.module';

@Module({
  imports: [
    PersistenceModule,
    ProvidersModule,
    ExecutionModule,
    HealthModule,
    EventsModule,
    ProjectModule,
    PipelineModule,
    IndexerModule,
    QualityModule,
  ],
})
export class AppModule {}
