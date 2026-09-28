/**
 * BullMQ queues shared with the workers.
 *
 * Queue names must not contain ':' (BullMQ 5 rejects them).
 */
import { Queue } from 'bullmq';
import { bullConnection } from './redis.js';

export const QUEUE_NAMES = {
  backups: 'owndatabase-backups',
  jobs: 'owndatabase-jobs',
} as const;

let _backup: Queue | null = null;
let _jobs: Queue | null = null;

export function backupQueue(): Queue {
  _backup ??= new Queue(QUEUE_NAMES.backups, { connection: bullConnection() });
  return _backup;
}

export function jobsQueue(): Queue {
  _jobs ??= new Queue(QUEUE_NAMES.jobs, {
    connection: bullConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: false,
    },
  });
  return _jobs;
}

export async function closeQueues() {
  await Promise.all([_backup?.close(), _jobs?.close()]);
}
