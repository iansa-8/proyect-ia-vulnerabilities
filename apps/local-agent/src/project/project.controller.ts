import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { SelectProjectDto } from './dto/select-project.dto';
import { UpdateProjectCommandsDto } from './dto/update-project-commands.dto';
import { ProjectService } from './project.service';
import {
  PathNotFoundError,
  PathValidationError,
} from '../common/path-validation';

@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Get()
  list() {
    return this.projectService.list();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.projectService.getById(id);
  }

  /**
   * Select / register a local project by absolute path.
   * Detects markers and persists ProjectProfile.
   */
  @Post()
  select(@Body() dto: SelectProjectDto) {
    try {
      return this.projectService.select(dto);
    } catch (err) {
      if (err instanceof PathValidationError) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof PathNotFoundError) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  @Patch(':id/commands')
  updateCommands(@Param('id') id: string, @Body() dto: UpdateProjectCommandsDto) {
    return this.projectService.updateCommands(id, dto);
  }
}
