import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Skill } from './skills.js';

/**
 * The isolated directory one agent run works in.
 *
 * Three layers keep the agent away from things it must not read, and the reason there are
 * three is that the first two are easy to get subtly wrong:
 *
 *  1. `docs/` is not mounted into this container at all. The answer key — which procedures
 *     are dead, what each one's oracle class is, where the planted bug lives — is simply
 *     not present in the filesystem the agent runs on. A path restriction can be argued
 *     with; an absent file cannot.
 *
 *  2. The workspace lives OUTSIDE the application directory. The SDK walks *up* from `cwd`
 *     looking for `.claude/`, so a scratch dir under /app would pick up whatever settings
 *     sit above it. Under /tmp there is nothing above it to find but the skills we linked.
 *
 *  3. `allowedTools` grants no Bash, no Glob, no Grep and no web access, and
 *     `permissionMode: 'dontAsk'` denies anything unlisted rather than prompting. Every
 *     fact about a procedure has to arrive through `read_procedure` or `query_capture`.
 *
 * `verify-m3` probes all of this rather than trusting it.
 */

export interface RunWorkspace {
  /** Passed to the SDK as `cwd`. */
  dir: string;
  /** Where the agent is told to put artefacts. */
  outDir: string;
  dispose: () => Promise<void>;
}

export async function createWorkspace(root: string, runId: string, skills: Skill[]): Promise<RunWorkspace> {
  const dir = join(root, runId);
  await rm(dir, { recursive: true, force: true });

  const skillsDir = join(dir, '.claude', 'skills');
  await mkdir(skillsDir, { recursive: true });
  const outDir = join(dir, 'out');
  await mkdir(outDir, { recursive: true });

  // Symlinked, not copied. The skill the agent loads is the same file on disk that the
  // Provoz page lists and that a reviewer can edit between runs.
  for (const skill of skills) await symlink(skill.path, join(skillsDir, skill.name), 'dir');

  return {
    dir,
    outDir,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** `make demo-reset` clears these along with Parity's Postgres. */
export async function clearWorkspaces(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
