import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
export const redisSub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (err) => console.error('Redis error', err.message));
redisSub.on('error', () => {});
