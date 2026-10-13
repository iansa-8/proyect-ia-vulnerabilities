import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { QUALITY_MAX_PAGE_SIZE } from '@amp/providers';
import { QualityService } from './quality.service';

class UpdateQualityConfigDto {
  @IsString()
  @MinLength(1)
  @MaxLength(400)
  projectKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  sonarProjectName?: string | null;

  @IsOptional()
  @IsBoolean()
  autoCreateProject?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrlOverride?: string | null;
}

@Controller()
export class QualityController {
  constructor(private readonly qualityService: QualityService) {}

  @Get('projects/:projectId/quality/config')
  getConfig(@Param('projectId') projectId: string) {
    return this.qualityService.getConfigView(projectId);
  }

  @Put('projects/:projectId/quality/config')
  updateConfig(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateQualityConfigDto,
  ) {
    return this.qualityService.updateConfig(projectId, {
      projectKey: dto.projectKey,
      sonarProjectName: dto.sonarProjectName,
      autoCreateProject: dto.autoCreateProject,
      baseUrlOverride: dto.baseUrlOverride,
    });
  }

  @Post('projects/:projectId/quality/test-connection')
  testConnection(@Param('projectId') projectId: string) {
    return this.qualityService.testConnection(projectId);
  }

  @Post('projects/:projectId/quality/create-project')
  createProject(@Param('projectId') projectId: string) {
    return this.qualityService.createRemoteProject(projectId);
  }

  @Get('projects/:projectId/quality/scanner-health')
  scannerHealth(@Param('projectId') projectId: string) {
    return this.qualityService.scannerHealth(projectId);
  }

  @Get('projects/:projectId/quality/health')
  health(@Param('projectId') projectId: string) {
    return this.qualityService.health(projectId);
  }

  @Get('projects/:projectId/quality/issues')
  getIssues(
    @Param('projectId') projectId: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('severity') severity?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('rule') rule?: string,
    @Query('file') file?: string,
    @Query('search') search?: string,
  ) {
    const page = parsePositiveInt(pageRaw, 1);
    const pageSize = Math.min(
      QUALITY_MAX_PAGE_SIZE,
      parsePositiveInt(pageSizeRaw, 50),
    );
    return this.qualityService.getIssues(projectId, {
      page,
      pageSize,
      filters: {
        severity,
        type,
        status,
        rule,
        file,
        search,
      },
    });
  }

  @Get('projects/:projectId/quality/issues/:issueId')
  getIssue(
    @Param('projectId') projectId: string,
    @Param('issueId') issueId: string,
  ) {
    return this.qualityService.getIssue(projectId, issueId);
  }

  @Get('projects/:projectId/quality/issues/:issueId/report')
  getIssueReport(
    @Param('projectId') projectId: string,
    @Param('issueId') issueId: string,
  ) {
    return this.qualityService.getIssueReport(projectId, issueId);
  }

  @Post('projects/:projectId/quality/issues/:issueId/context')
  getIssueContext(
    @Param('projectId') projectId: string,
    @Param('issueId') issueId: string,
  ) {
    return this.qualityService.getIssueContext(projectId, issueId);
  }

  @Get('projects/:projectId/quality/snapshots')
  listSnapshots(@Param('projectId') projectId: string) {
    return this.qualityService.listSnapshots(projectId);
  }

  @Get('projects/:projectId/quality/snapshots/:snapshotId')
  getSnapshot(
    @Param('projectId') projectId: string,
    @Param('snapshotId') snapshotId: string,
  ) {
    return this.qualityService.getSnapshot(projectId, snapshotId);
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.floor(n);
}
