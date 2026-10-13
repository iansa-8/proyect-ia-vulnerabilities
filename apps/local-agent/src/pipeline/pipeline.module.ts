import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { ExecutionModule } from '../execution/execution.module';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [EventsModule, ExecutionModule],
  controllers: [PipelineController],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}
