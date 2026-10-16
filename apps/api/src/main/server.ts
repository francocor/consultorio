import type { Writable } from 'node:stream';

import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { healthRoutes, type HealthDeps } from '../platform/http/health.js';

import { buildLoggerOptions } from './logger.js';

export interface BuildServerOptions {
  logLevel?: string;
  /** Destination for log lines. Defaults to stdout. Tests pass a capturing stream. */
  logStream?: Writable;
  health: HealthDeps;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const loggerOptions = buildLoggerOptions(options.logLevel ?? 'info');

  const app = Fastify({
    logger: options.logStream ? { ...loggerOptions, stream: options.logStream } : loggerOptions,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  void app.register(healthRoutes(options.health));

  return app;
}
