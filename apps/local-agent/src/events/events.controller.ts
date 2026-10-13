import { Controller, Post } from '@nestjs/common';
import type { PlatformEvent } from '@amp/core';
import { EventsGateway } from './events.gateway';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsGateway: EventsGateway) {}

  /** Demo endpoint: emits a non-sensitive pipeline.started sample event. */
  @Post('demo')
  emitDemo() {
    const event: PlatformEvent = {
      type: 'pipeline.started',
      timestamp: new Date().toISOString(),
      payload: {
        runId: 'demo-run',
        projectId: 'demo-project',
        pipelineDefinitionId: 'basic-project-check',
      },
    };
    this.eventsGateway.emitEvent(event);
    return { emitted: true, event };
  }
}
