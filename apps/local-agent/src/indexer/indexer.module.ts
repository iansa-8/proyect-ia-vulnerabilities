import { Module, forwardRef } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module';
import { IndexerController } from './indexer.controller';
import { IndexerService } from './indexer.service';
import { CodeContextService } from './code-context.service';

@Module({
  imports: [forwardRef(() => PipelineModule)],
  controllers: [IndexerController],
  providers: [CodeContextService, IndexerService],
  exports: [IndexerService, CodeContextService],
})
export class IndexerModule {}
