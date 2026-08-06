import { useEffect, useState } from 'react';
import { cs } from '../copy';
import {
  fetchAudit,
  fetchPolicy,
  fetchRuntime,
  fetchSkills,
  type AuditEntryInfo,
  type PolicyRuleInfo,
  type Runtime,
  type SkillInfo,
} from '../lib/api';

/**
 * Skills, policy tiers and the audit log on one page — SCHEDULE folded the three separate
 * screens into this. Thin but real: every row is read from disk or from Postgres.
 */
export function Provoz(): JSX.Element {
  const [skills, setSkills] = useState<{ skillsDir: string; skills: SkillInfo[] } | null>(null);
  const [policy, setPolicy] = useState<PolicyRuleInfo[]>([]);
  const [audit, setAudit] = useState<AuditEntryInfo[]>([]);
  const [runtime, setRuntime] = useState<Runtime | null>(null);

  useEffect(() => {
    void fetchSkills().then(setSkills, () => undefined);
    void fetchPolicy().then((r) => setPolicy(r.rules), () => undefined);
    void fetchAudit().then((r) => setAudit(r.entries), () => undefined);
    void fetchRuntime().then(setRuntime, () => undefined);
  }, []);

  return (
    <>
      <div className="topline">
        <h1>{cs.ops.title}</h1>
        {skills !== null && <span className="subtle mono">{skills.skillsDir}</span>}
      </div>

      {runtime !== null && !runtime.agentReady && (
        <p className="notice">{cs.ops.agentBlocked(runtime.agentBlockedReason)}</p>
      )}

      <h2>{cs.ops.skillsTitle}</h2>
      <p className="subtle">{cs.ops.skillsHint}</p>
      <table>
        <thead>
          <tr>
            <th>{cs.ops.skillColumns.name}</th>
            <th>{cs.ops.skillColumns.description}</th>
            <th>{cs.ops.skillColumns.model}</th>
            <th>{cs.ops.skillColumns.from}</th>
          </tr>
        </thead>
        <tbody>
          {(skills?.skills ?? []).map((skill) => (
            <tr key={skill.name}>
              <td className="name">{skill.name}</td>
              <td>{skill.description}</td>
              <td className="name">{skill.model}</td>
              <td>
                <span className="chip none">{skill.availableFrom}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{cs.ops.policyTitle}</h2>
      <p className="subtle">{cs.ops.policyHint}</p>
      <table>
        <thead>
          <tr>
            <th>{cs.ops.policyColumns.taskClass}</th>
            <th>{cs.ops.policyColumns.tool}</th>
            <th className="num">{cs.ops.policyColumns.tier}</th>
            <th>{cs.ops.policyColumns.human}</th>
            <th>{cs.ops.policyColumns.note}</th>
          </tr>
        </thead>
        <tbody>
          {policy.map((rule) => (
            <tr key={rule.id}>
              <td className="name">{rule.taskClass}</td>
              <td className="name">{rule.toolName}</td>
              <td className="num">
                <span className={`chip ${rule.tier >= 3 ? 'bad' : rule.tier === 2 ? 'warn' : 'good'}`}>{rule.tier}</span>
              </td>
              <td>{rule.requiresHuman ? <span className="chip bad">ano</span> : <span className="chip none">ne</span>}</td>
              <td className="subtle">{rule.note ?? cs.common.none}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{cs.ops.auditTitle}</h2>
      <p className="subtle">{cs.ops.auditHint}</p>
      {audit.length === 0 ? (
        <p className="empty">{cs.ops.auditEmpty}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{cs.ops.auditColumns.when}</th>
              <th>{cs.ops.auditColumns.run}</th>
              <th>{cs.ops.auditColumns.tool}</th>
              <th>{cs.ops.auditColumns.outcome}</th>
              <th className="num">{cs.ops.auditColumns.duration}</th>
              <th>{cs.ops.auditColumns.detail}</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((entry) => (
              <tr key={entry.id}>
                <td className="mono subtle">{new Date(entry.createdAt).toLocaleTimeString('cs-CZ')}</td>
                <td className="mono subtle">{entry.skill}</td>
                <td className="name">{entry.toolName}</td>
                <td>
                  <span className={`chip ${cs.ops.outcomes[entry.outcome]?.tone ?? 'none'}`}>
                    {cs.ops.outcomes[entry.outcome]?.label ?? entry.outcome}
                  </span>
                </td>
                <td className="num">{entry.durationMs === null ? cs.common.none : `${entry.durationMs} ms`}</td>
                <td className="subtle audit-detail">{entry.reason ?? entry.inputSummary ?? cs.common.none}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
