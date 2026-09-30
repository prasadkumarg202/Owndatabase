/** Secrets from the control API's vault (docs/vault.md): sealed auth settings are resolved here. */
import { VaultClient } from './vault-client.js';
import { platform } from './session.js';

export const vault = new VaultClient();
platform.onProjectChanged((id) => vault.invalidate(id));

const SEALED = 'vault:v1:';

/**
 * The plaintext of an auth-settings secret. Sealed values come from the vault; anything else
 * (platform environment defaults) is returned as is.
 */
export async function authSecret(projectId: string, name: string, stored: string | undefined): Promise<string | undefined> {
  if (!stored) return undefined;
  if (!stored.startsWith(SEALED)) return stored;
  return (await vault.reveal(projectId, 'auth'))[name];
}
