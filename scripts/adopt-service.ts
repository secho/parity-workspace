// `make adopt-service`. Materialise the generated service from Parity's store onto disk.
//
// This runs on the HOST, and that is the whole point of it existing. parity-api has no mount
// into `parity-platform-demo-app` and does not get one at M6: `decide()` waves through every
// tool whose name is not prefixed `mcp__parity__`, and the SDK's built-in `Write` is exactly
// that — a write mount would hand the agent a capability the tier table does not govern, does
// not display and cannot refuse, in the milestone whose entire claim is that the platform gates
// what the agent does.
//
// So the agent writes rows, this reads them over HTTP, and the two containers pick the files up
// through `tsx watch`. Parity's only channels to the demo app stay the ones SPEC §2 names.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = `http://127.0.0.1:${process.env.PARITY_API_PORT ?? 3200}`;
const SRC = join(ROOT, 'parity-platform-demo-app', 'pricing-service-generated', 'src');

const TARGETS = [
  { name: 'pricing-service-generated', port: process.env.PRICING_SERVICE_GENERATED_PORT ?? '3301' },
  { name: 'pricing-service-live', port: process.env.PRICING_SERVICE_LIVE_PORT ?? '3302' },
];

const procedureName = process.argv[2] ?? 'sp_CalculateOrderTotal';

interface ServiceResponse {
  complete: boolean;
  artifacts: { attempt: number; runHash: string; files: { path: string; contents: string; sha256: string }[] } | null;
}

const response = await fetch(`${API}/api/procedures/${procedureName}/service`);
if (!response.ok) {
  console.error(`parity-api returned ${response.status} for ${procedureName}`);
  process.exit(1);
}

const { complete, artifacts } = (await response.json()) as ServiceResponse;

if (artifacts === null) {
  console.error(`no generated service for ${procedureName} — run \`make implement-service\` first`);
  process.exit(1);
}

// Half a service is worse than none. The container would keep serving whichever file the last
// attempt left behind, and the shadow run would compare the procedure against a chimera of two
// attempts with nothing in the recorded row to say so.
if (!complete) {
  console.error(
    `attempt ${artifacts.attempt} is incomplete — only ${artifacts.files.map((f) => f.path).join(', ')} were written. Not adopting.`,
  );
  process.exit(1);
}

await mkdir(SRC, { recursive: true });
for (const file of artifacts.files) {
  await writeFile(join(SRC, file.path), file.contents, 'utf8');
  console.log(`  ${file.path}  ${file.contents.length} bytes  sha256 ${file.sha256.slice(0, 12)}`);
}

// The stamp both services echo at /health. It is what makes "the service that was replayed is
// the source the agent wrote" a query across two systems rather than an assumption — M5 lost a
// day to a container serving a stale copy of a file that had already been edited on the host.
await writeFile(join(SRC, '.artifact'), `${artifacts.runHash}\n`, 'utf8');
console.log(`adopted attempt ${artifacts.attempt}, artifact ${artifacts.runHash.slice(0, 12)}`);

// tsx watch restarts on change, so /health lags the write by a second or two. Waiting here
// rather than in the Makefile means a shadow run started straight afterwards cannot race it.
for (const target of TARGETS) {
  process.stdout.write(`waiting for ${target.name}`);
  const deadline = Date.now() + 60_000;
  let seen: string | null = null;

  while (Date.now() < deadline) {
    try {
      const health = (await (await fetch(`http://127.0.0.1:${target.port}/health`)).json()) as {
        status: string;
        artifact: string | null;
      };
      seen = health.artifact;
      if (health.status === 'ok' && health.artifact === artifacts.runHash) break;
    } catch {
      // Not up yet, or restarting under tsx watch. Both are expected here.
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (seen !== artifacts.runHash) {
    console.error(`\n  ${target.name} reports artifact ${seen ?? 'none'}, expected ${artifacts.runHash.slice(0, 12)}`);
    process.exit(1);
  }
  console.log(' serving');
}
