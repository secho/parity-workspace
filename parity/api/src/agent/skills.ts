import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Skills are real files on disk, not a UI decoration.
 *
 * `parity/skills/<name>/SKILL.md` is the layout the Agent SDK discovers, and it is the
 * same directory the UI lists and the same file the agent loads. That is what makes
 * "update one file and every agent run picks it up" literally true rather than a claim —
 * it can be demonstrated live by editing a skill mid-demo and re-running.
 */

export interface Skill {
  name: string;
  description: string;
  /** Absolute path to the directory, which is what gets linked into a run workspace. */
  path: string;
  /** The model this skill runs on. Bulk work is cheap; the hard single shots are not. */
  model: string;
  /** Milestone that puts this skill to work. The UI says so rather than implying it runs. */
  availableFrom: string;
}

/**
 * Model per skill — the same routing argument the deck makes, made executable. Triage and
 * spec extraction run across the whole estate and go on a Sonnet-class model; the hard
 * single-shot work escalates. Visible in the UI so nobody has to take it on trust.
 */
const MODELS: Record<string, { model: string; availableFrom: string }> = {
  triage: { model: 'claude-sonnet-5', availableFrom: 'M3' },
  'extract-spec': { model: 'claude-sonnet-5', availableFrom: 'M3' },
  'generate-oracle': { model: 'claude-sonnet-5', availableFrom: 'M4' },
  'classify-diff': { model: 'claude-opus-5', availableFrom: 'M5' },
  'implement-service': { model: 'claude-opus-5', availableFrom: 'M6' },
};

const DEFAULT_MODEL = 'claude-sonnet-5';

/** Minimal YAML front matter reader: `name` and `description`, which is all a SKILL.md has. */
function frontMatter(source: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (match === null) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(skillsDir, entry.name);
    const source = await readFile(join(path, 'SKILL.md'), 'utf8');
    const fields = frontMatter(source);
    const routing = MODELS[entry.name] ?? { model: DEFAULT_MODEL, availableFrom: '—' };
    skills.push({
      // The directory name is what the SDK matches on, so it wins over the front matter.
      name: entry.name,
      description: fields.description ?? '',
      path,
      model: routing.model,
      availableFrom: routing.availableFrom,
    });
  }

  return skills;
}

export async function findSkill(skillsDir: string, name: string): Promise<Skill> {
  const skill = (await loadSkills(skillsDir)).find((s) => s.name === name);
  if (skill === undefined) throw new Error(`no skill named ${name} in ${skillsDir}`);
  return skill;
}
