/** CLI configuration stored in ~/.config/owndatabase/cli.json (override with ODB_CONFIG). */
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CliConfig { url: string; access_token?: string; refresh_token?: string; email?: string }

const file = process.env['ODB_CONFIG'] ?? join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'owndatabase', 'cli.json');

export function loadConfig(): CliConfig {
  try { return { url: 'http://localhost', ...JSON.parse(readFileSync(file, 'utf8')) }; }
  catch { return { url: 'http://localhost' }; }
}

export function saveConfig(cfg: CliConfig) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  try { chmodSync(file, 0o600); } catch { /* windows */ }
}

export const configPath = file;
