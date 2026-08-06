/**
 * Structural half of the containment proof: what the agent's workspace actually contains,
 * and what it cannot see from there. Needs no model, so it runs in every `verify-m3`.
 *
 * The live half — pointing the real agent at docs/SPEC.md and watching it fail — is
 * `probe-containment.ts`.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { loadSkills } from '../agent/skills.js';
import { createWorkspace } from '../agent/workspace.js';

const SKILLS_DIR = process.env.PARITY_SKILLS_DIR ?? '/app/skills';
const WORKSPACE_ROOT = process.env.PARITY_AGENT_WORKSPACE ?? '/tmp/parity-agent';

const skills = await loadSkills(SKILLS_DIR);
const workspace = await createWorkspace(WORKSPACE_ROOT, 'probe-workspace', skills);
const skillDir = `${workspace.dir}/.claude/skills`;

const report = {
  skills: skills.map((s) => ({ name: s.name, model: s.model, availableFrom: s.availableFrom, hasDescription: s.description !== '' })),
  workspace: workspace.dir,
  linked: readdirSync(skillDir).map((name) => ({
    name,
    isSymlink: lstatSync(`${skillDir}/${name}`).isSymbolicLink(),
    skillMdReadable: existsSync(`${skillDir}/${name}/SKILL.md`),
  })),
  containment: {
    // The workspace sits outside the application directory, so the SDK's walk up from cwd
    // looking for .claude finds only what we linked.
    workspaceOutsideApp: !workspace.dir.startsWith('/app'),
    // docs/ is not mounted into this container at all — the answer key is not merely
    // out of reach, it is absent.
    docsPresent: existsSync('/app/docs') || existsSync('/docs'),
    // Nothing above the workspace root to inherit settings from.
    claudeAboveWorkspace: existsSync('/tmp/.claude') || existsSync('/.claude'),
    appClaudePresent: existsSync('/app/.claude'),
  },
};

await workspace.dispose();
console.log(JSON.stringify({ ...report, disposed: !existsSync(workspace.dir) }, null, 2));
