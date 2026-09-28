import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

redis.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));

/** A dedicated connection factory for BullMQ (which needs maxRetriesPerRequest=null). */
export function bullConnection() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}
