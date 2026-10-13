import { Injectable } from '@nestjs/common';
import { SqliteService } from '../persistence/sqlite.service';

@Injectable()
export class HealthService {
  constructor(private readonly sqlite: SqliteService) {}

  getStatus() {
    return {
      status: 'ok',
      service: 'local-agent',
      phase: 3,
      timestamp: new Date().toISOString(),
      sqlite: {
        ready: this.sqlite.isReady(),
        path: this.sqlite.getDbPath(),
      },
    };
  }
}
