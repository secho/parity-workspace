import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { llmRoute } from '../env.js';
import { createWorkspace } from './workspace.js';
import type { Skill } from './skills.js';

/**
 * The one place Parity talks to a model.
 *
 * Every run is single-skill, single-procedure, and isolated: its own workspace, its own
 * tool grant, an explicit turn ceiling and an explicit permission posture. Unattended runs
 * never use `bypassPermissions` — `dontAsk` denies anything not pre-approved instead of
 * prompting, which is the only sane posture for a loop nobody is watching.
 */

export interface RunOptions {
  skill: Skill;
  prompt: string;
  workspaceRoot: string;
  runId: string;
  /** All five skills are linked in, but only this one is enabled for the run. */
  allSkills: Skill[];
  maxTurns: number;
  allowedTools: string[];
  mcpServers?: Options['mcpServers'];
  hooks?: Options['hooks'];
  signal?: AbortSignal;
  onMessage?: (message: SDKMessage) => void | Promise<void>;
}

export interface RunResult {
  /** The model that actually served the run, read off the SDK's init message. */
  model: string | null;
  /** Skills the SDK reports as loaded. Empty means the workspace was built wrong. */
  skillsLoaded: string[];
  text: string;
  isError: boolean;
  stopReason: string | null;
  numTurns: number;
  durationMs: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Tool calls the permission layer refused. The policy gate's receipts. */
  permissionDenials: { tool_name: string; tool_input: unknown }[];
}

/**
 * Where the model is actually reached — the top-right badge reads this.
 *
 * Three routes, one config line apart, which is the whole "point it at yours" argument:
 * the Anthropic API directly, a LiteLLM-compatible gateway, or Claude Platform on AWS
 * (Anthropic-operated, AWS IAM and Marketplace billing — not Amazon Bedrock).
 */
export function llmEndpoint(): { provider: string; baseUrl: string | null } {
  switch (llmRoute()) {
    case 'anthropic_aws':
      return {
        provider: 'Claude Platform on AWS',
        baseUrl: process.env.AWS_REGION === undefined ? null : `${process.env.AWS_REGION} · ${process.env.ANTHROPIC_AWS_WORKSPACE_ID ?? '?'}`,
      };
    case 'gateway':
      return { provider: 'LLM Gateway', baseUrl: process.env.ANTHROPIC_BASE_URL ?? null };
    default:
      return { provider: 'Anthropic API', baseUrl: null };
  }
}

export async function runSkill(options: RunOptions): Promise<RunResult> {
  const workspace = await createWorkspace(options.workspaceRoot, options.runId, options.allSkills);

  const result: RunResult = {
    model: null,
    skillsLoaded: [],
    text: '',
    isError: false,
    stopReason: null,
    numTurns: 0,
    durationMs: 0,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    permissionDenials: [],
  };

  try {
    const stream = query({
      prompt: options.prompt,
      options: {
        cwd: workspace.dir,
        // 'project' finds .claude/skills inside the workspace we just built. NOT 'user',
        // which would pull in whatever the operator has in ~/.claude.
        settingSources: ['project'],
        skills: [options.skill.name],
        additionalDirectories: [],
        allowedTools: options.allowedTools,
        permissionMode: 'dontAsk',
        maxTurns: options.maxTurns,
        model: options.skill.model,
        mcpServers: options.mcpServers,
        hooks: options.hooks,
        abortController: options.signal === undefined ? undefined : abortControllerFor(options.signal),
      },
    });

    for await (const message of stream) {
      await options.onMessage?.(message);

      if (message.type === 'system' && message.subtype === 'init') {
        result.model = message.model;
        result.skillsLoaded = message.skills;
      }

      if (message.type === 'result') {
        result.durationMs = message.duration_ms;
        result.numTurns = message.num_turns;
        result.isError = message.is_error;
        result.costUsd = message.total_cost_usd;
        result.permissionDenials = message.permission_denials.map((d) => ({
          tool_name: d.tool_name,
          tool_input: d.tool_input,
        }));
        if (message.subtype === 'success') {
          result.text = message.result;
          result.stopReason = message.stop_reason;
          result.inputTokens = message.usage.input_tokens;
          result.outputTokens = message.usage.output_tokens;
        } else {
          result.isError = true;
          result.stopReason = message.subtype;
        }
      }
    }
  } finally {
    await workspace.dispose();
  }

  return result;
}

function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}
