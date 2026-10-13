import { Injectable } from '@nestjs/common';
import type { ProjectProfile } from '@amp/core';
import { detectProjectProfile } from './project-detector';

@Injectable()
export class ProjectDetectorService {
  detect(projectRoot: string): ProjectProfile {
    return detectProjectProfile(projectRoot);
  }
}
