// Runs on every page: shows the sandbox banner when the backend is in sandbox mode.
import { api } from './api.js';

export async function showSandboxBanner({ root = globalThis.document, client = api } = {}) {
  const banner = root.getElementById('sandbox-banner');
  if (!banner) return;

  try {
    const config = await client.get('/api/config', { auth: false });
    banner.hidden = config.sandbox !== true;
  } catch {
    // If the config cannot be read, the banner stays hidden rather than guessing.
    banner.hidden = true;
  }
}

if (globalThis.document) {
  showSandboxBanner();
}
