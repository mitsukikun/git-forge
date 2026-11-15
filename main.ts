// main.ts — the entrypoint: derive the viewer from the contest's fixed scenario seed,
// build the forge, bind an ephemeral port, register with the environment server, and
// serve until the environment says the run is done.
//
// Lifecycle, as the kit's harness expects it:
//   1. bind port 0 (never a fixed port) and start listening;
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register — 200 is normal, 409 means a
//      registration already exists (keep serving); 400/405 are fatal; network errors
//      retry with exponential backoff (250 ms -> 2000 ms);
//   3. long-poll GET $MAKEFUN_ENV_URL/done until {"done": true}, then close and exit 0.
// Without MAKEFUN_ENV_URL the process exits 1.

import { createForgeServer } from './server.ts';
import { deriveViewer } from './scenario.ts';
import { Forge } from './store.ts';

const REGISTER_BACKOFF_MS = [250, 500, 1000, 2000];
const DONE_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register this process's port with the environment server. Fatal statuses exit 1. */
async function register(envUrl: string, port: number): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/register`;
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200 || response.status === 409) {
        if (response.status === 409) console.error('gitforge: register returned 409 (already registered); serving anyway');
        return;
      }
      if (response.status === 400 || response.status === 405) {
        console.error(`gitforge: register rejected with ${response.status}; exiting`);
        process.exit(1);
      }
      console.error(`gitforge: register returned ${response.status}; retrying`);
    } catch (err) {
      console.error(`gitforge: register failed: ${err instanceof Error ? err.message : String(err)}; retrying`);
    }
    const delay = REGISTER_BACKOFF_MS[Math.min(attempt, REGISTER_BACKOFF_MS.length - 1)] as number;
    attempt += 1;
    if (attempt > 12) {
      console.error('gitforge: register never succeeded; exiting');
      process.exit(1);
    }
    await sleep(delay);
  }
}

/** Poll GET $MAKEFUN_ENV_URL/done until the run is over. */
async function waitForDone(envUrl: string): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/done`;
  for (;;) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment server dropped the poll; retry after a short pause.
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('gitforge: MAKEFUN_ENV_URL is not set; exiting');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const viewer = deriveViewer();
  const forge = new Forge(viewer, token);
  const server = createForgeServer(forge);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.error(`gitforge: listening on 127.0.0.1:${port} as ${viewer.login}`);
  await register(envUrl, port);
  await waitForDone(envUrl);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((err) => {
  console.error(`gitforge: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
