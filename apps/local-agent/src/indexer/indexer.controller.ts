import {
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { IndexerService } from './indexer.service';

class StartIndexDto {
  @IsOptional()
  @IsBoolean()
  forceReindex?: boolean;
}

class IndexContextDto {
  @IsString()
  symbol!: string;

  @IsOptional()
  @IsString()
  file?: string;
}

@Controller()
export class IndexerController {
  constructor(private readonly indexerService: IndexerService) {}

  @Get('indexer/health')
  health() {
    return this.indexerService.health();
  }

  @Get('projects/:projectId/index')
  getIndex(@Param('projectId') projectId: string) {
    return this.indexerService.getProjectIndex(projectId);
  }

  @Post('projects/:projectId/index')
  startIndex(
    @Param('projectId') projectId: string,
    @Body() dto: StartIndexDto,
  ) {
    return this.indexerService.startIndex(projectId, dto.forceReindex === true);
  }

  @Post('projects/:projectId/index/context')
  getContext(
    @Param('projectId') projectId: string,
    @Body() dto: IndexContextDto,
  ) {
    return this.indexerService.getContext(projectId, dto);
  }
}
