import './env';
import 'reflect-metadata';
import { LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config/app-config';

const LOG_LEVELS: Record<'log' | 'debug' | 'verbose', LogLevel[]> = {
  log: ['error', 'warn', 'log'],
  debug: ['error', 'warn', 'log', 'debug'],
  verbose: ['error', 'warn', 'log', 'debug', 'verbose'],
};

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.useLogger(LOG_LEVELS[config.logLevel]);
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: config.corsOrigin,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(config.port, config.host);
  console.log(`local-agent listening on http://${config.host}:${config.port} (logLevel=${config.logLevel})`);
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to start local-agent', err);
  process.exit(1);
});
