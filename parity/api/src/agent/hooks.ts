import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Db } from '../db/client.js';
import { auditEntries } from '../db/schema.js';
import { decide, type Tier } from './policy.js';

/**
 * Policy and the audit log, both as hooks.
 *
 * `PreToolUse` is where the tier table is enforced. Returning a deny here stops the call
 * before it runs — the model cannot talk its way past it, because the decision is made
 * outside the conversation.
 *
 * `PostToolUse` is where the audit log comes from. Nothing is instrumented by hand, so
 * nothing can be forgotten: if a tool ran, there is a row. `verify-m3` asserts the count
 * of audit rows matches the count of tool-use steps for every run.
 */

export interface HookContext {
  db: Db;
  agentRunId: number;
  policy: Map<string, Tier>;
  /** Bumped by both hooks so the audit log keeps the order the agent acted in. */
  nextSeq: () => number;
  onBlocked?: (toolName: string, reason: string) => void;
}

const summarise = (value: unknown, limit = 500): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

export function buildHooks(context: HookContext): Options['hooks'] {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            const verdict = decide(context.policy, input.tool_name);
            if (verdict.allow) return {};

            await context.db.insert(auditEntries).values({
              agentRunId: context.agentRunId,
              seq: context.nextSeq(),
              toolName: input.tool_name,
              inputSummary: summarise(input.tool_input),
              resultSummary: null,
              outcome: 'blocked',
              reason: verdict.reason,
            });
            context.onBlocked?.(input.tool_name, verdict.reason);

            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: verdict.reason,
              },
            };
          },
        ],
      },
    ],

    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PostToolUse') return {};
            await context.db.insert(auditEntries).values({
              agentRunId: context.agentRunId,
              seq: context.nextSeq(),
              toolName: input.tool_name,
              inputSummary: summarise(input.tool_input),
              resultSummary: summarise(input.tool_response),
              durationMs: input.duration_ms ?? null,
              outcome: 'allowed',
              reason: null,
            });
            return {};
          },
        ],
      },
    ],
  };
}
