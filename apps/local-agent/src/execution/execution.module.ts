import { Module } from '@nestjs/common';
import { CommandExecutionService } from './command-execution.service';

@Module({
  providers: [CommandExecutionService],
  exports: [CommandExecutionService],
})
export class ExecutionModule {}
