import { config as loadEnv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

function tryLoadEnv(filePath: string): void {
  if (fs.existsSync(filePath)) {
    loadEnv({ path: filePath });
  }
}

// Prefer monorepo root .env, then local-agent .env
tryLoadEnv(path.resolve(process.cwd(), '../../.env'));
tryLoadEnv(path.resolve(process.cwd(), '.env'));
tryLoadEnv(path.resolve(__dirname, '../../../.env'));
