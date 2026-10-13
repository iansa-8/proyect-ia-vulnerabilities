import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { ProjectDetectorService } from './detection/project-detector.service';

@Module({
  controllers: [ProjectController],
  providers: [ProjectService, ProjectDetectorService],
  exports: [ProjectService],
})
export class ProjectModule {}
