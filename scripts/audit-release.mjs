import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Withdrawn 2026-11-18; some registry responses still include this advisory.
// https://github.com/advisories/GHSA-fc5q-39xc-vjpf
// Exempt the exact advisory, never picomatch or its dependents as packages.
const withdrawn = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const severities = ['info', 'low', 'moderate', 'high', 'critical'];

export function reviewReleaseAudit(report) {
  const findings = report?.vulnerabilities;
  const counts = report?.metadata?.vulnerabilities;
  if (
    report?.error ||
    report?.auditReportVersion !== 2 ||
    !findings ||
    typeof findings !== 'object' ||
    Array.isArray(findings) ||
    !counts ||
    counts.total !== Object.keys(findings).length
  )
    throw new Error('Missing or unsupported npm audit report');
  for (const severity of severities) {
    const actual = Object.values(findings).filter(
      (finding) => finding?.severity === severity,
    ).length;
    if (counts[severity] !== actual) throw new Error('Inconsistent npm audit report');
  }
  const withdrawnOnly = (name, visiting = new Set()) => {
    if (visiting.has(name)) return false;
    const finding = findings[name];
    if (!Array.isArray(finding?.via) || !finding.via.length) return false;
    const path = new Set([...visiting, name]);
    return finding.via.every((cause) =>
      typeof cause === 'string'
        ? withdrawnOnly(cause, path)
        : cause?.name === 'picomatch' && cause?.url === withdrawn,
    );
  };
  const failures = [],
    ignored = [];
  for (const [name, finding] of Object.entries(findings)) {
    if (!severities.includes(finding?.severity))
      throw new Error(`Unknown audit severity for ${name}`);
    if (['high', 'critical'].includes(finding.severity))
      (withdrawnOnly(name) ? ignored : failures).push(name);
  }
  return { failures, ignored };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = spawnSync('npm', ['audit', '--audit-level=high', '--json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || ![0, 1].includes(result.status))
      throw result.error ?? new Error(result.stderr || 'npm audit did not complete');
    const { failures, ignored } = reviewReleaseAudit(JSON.parse(result.stdout));
    if (ignored.length)
      console.log(`Exempted withdrawn advisory ${withdrawn}: ${ignored.join(', ')}`);
    if (failures.length) {
      console.error(result.stdout);
      console.error(`Release audit failed: ${failures.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('Release audit passed: no non-exempt high or critical vulnerabilities.');
    }
  } catch (error) {
    console.error('Release audit failed:', error.message);
    process.exitCode = 1;
  }
}
