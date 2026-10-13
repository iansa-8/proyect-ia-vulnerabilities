import { Injectable, NotFoundException } from '@nestjs/common';
import path from 'node:path';
import type {
  ProjectCommandOverrides,
  ProjectProfile,
  ProjectRecord,
} from '@amp/core';
import {
  mergeProjectProfile,
  PROJECT_COMMAND_KEYS,
  type ProjectCommandKey,
} from '@amp/core';
import { ProjectRepository } from '../persistence/project.repository';
import {
  assertExistingProjectDirectory,
  validateProjectPath,
} from '../common/path-validation';
import { ProjectDetectorService } from './detection/project-detector.service';
import { SelectProjectDto } from './dto/select-project.dto';
import { UpdateProjectCommandsDto } from './dto/update-project-commands.dto';

export interface ProjectView extends ProjectRecord {
  /** Detected profile with command overrides applied. */
  effectiveProfile: ProjectProfile;
}

@Injectable()
export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly detector: ProjectDetectorService,
  ) {}

  list(): ProjectView[] {
    return this.projects.list().map((record) => this.toView(record));
  }

  getById(id: string): ProjectView {
    const record = this.projects.findById(id);
    if (!record) {
      throw new NotFoundException(`Project not found: ${id}`);
    }
    return this.toView(record);
  }

  /**
   * Validates path, detects profile markers, and upserts the project by path.
   */
  select(dto: SelectProjectDto): ProjectView {
    const safePath = validateProjectPath(dto.path);
    assertExistingProjectDirectory(safePath);

    const profile = this.detector.detect(safePath);
    const name = dto.name?.trim() || path.basename(safePath) || 'proyecto';

    const existing = this.projects.findByPath(safePath);
    if (existing) {
      const updated = this.projects.updateProfile(existing.id, profile, name);
      if (!updated) {
        throw new NotFoundException(`Project not found: ${existing.id}`);
      }
      return this.toView(updated);
    }

    const created = this.projects.create({
      name,
      path: safePath,
      profile,
    });
    return this.toView(created);
  }

  updateCommands(id: string, dto: UpdateProjectCommandsDto): ProjectView {
    const existing = this.projects.findById(id);
    if (!existing) {
      throw new NotFoundException(`Project not found: ${id}`);
    }

    const nextOverrides: ProjectCommandOverrides = {
      ...(existing.commandOverrides ?? {}),
    };

    for (const key of PROJECT_COMMAND_KEYS) {
      if (Object.prototype.hasOwnProperty.call(dto, key)) {
        const value = dto[key as keyof UpdateProjectCommandsDto];
        if (value === undefined) {
          continue;
        }
        nextOverrides[key as ProjectCommandKey] = value;
      }
    }

    const updated = this.projects.updateCommandOverrides(id, nextOverrides);
    if (!updated) {
      throw new NotFoundException(`Project not found: ${id}`);
    }
    return this.toView(updated);
  }

  private toView(record: ProjectRecord): ProjectView {
    const detected = record.profile ?? this.emptyProfile();
    return {
      ...record,
      profile: detected,
      effectiveProfile: mergeProjectProfile(detected, record.commandOverrides),
    };
  }

  emptyProfile(): ProjectProfile {
    return {
      hasDocker: false,
      hasSonar: false,
    };
  }
}
