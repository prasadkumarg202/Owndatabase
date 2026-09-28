import postgres from 'postgres';
import { config } from '../config.js';

// Column names stay snake_case (no transform) — the code relies on that.
export const db = postgres(config.DATABASE_URL, { max: 10, idle_timeout: 30, onnotice: () => {} });
