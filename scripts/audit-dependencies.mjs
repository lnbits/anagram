import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const advisory = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const expires = Date.parse('2026-12-01T00:00:00Z');
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const reviewedTools = new Set([
  'picomatch',
  'fdir',
  'tinyglobby',
  'vite',
  'vitest',
  'svelte-check',
  '@sveltejs/kit',
  '@sveltejs/adapter-static',
  '@sveltejs/vite-plugin-svelte',
]);

// See docs/dependency-audit.md. This is a temporary build-tool risk acceptance,
// not a patched dependency. Unknown findings and production paths still fail.
export function evaluateAudit(report, lock, now = Date.now()) {
  if (
    report?.error ||
    report?.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    Array.isArray(report.vulnerabilities) ||
    !lock?.packages ||
    !Number.isFinite(now)
  )
    throw new Error('Invalid npm audit report or lockfile');
  const findings = report.vulnerabilities;
  for (const [name, finding] of Object.entries(findings)) {
    if (
      finding?.name !== name ||
      !severities.includes(finding.severity) ||
      !Array.isArray(finding.via) ||
      !finding.via.length ||
      !Array.isArray(finding.nodes) ||
      !finding.nodes.length
    )
      throw new Error(`Invalid npm audit finding: ${name}`);
  }
  for (const severity of severities) {
    const count = Object.values(findings).filter((v) => v.severity === severity).length;
    if (report.metadata?.vulnerabilities?.[severity] !== count) {
      throw new Error(`Inconsistent npm audit totals: ${severity}`);
    }
  }

  function excepted(name, parents = new Set()) {
    const finding = findings[name];
    if (
      now >= expires ||
      parents.has(name) ||
      !finding ||
      finding.severity !== 'high' ||
      !reviewedTools.has(name) ||
      finding.nodes.length !== 1 ||
      finding.nodes[0] !== `node_modules/${name}` ||
      !finding.nodes.every((path) => lock.packages[path]?.dev === true)
    )
      return false;
    const visited = new Set([...parents, name]);
    return finding.via.every((cause) => {
      if (typeof cause === 'string') return excepted(cause, visited);
      return (
        name === 'picomatch' &&
        cause?.name === 'picomatch' &&
        cause.dependency === 'picomatch' &&
        cause.url === advisory &&
        cause.severity === 'high' &&
        cause.range === '<=4.0.7' &&
        finding.nodes.every((path) => lock.packages[path]?.version === '4.0.7')
      );
    });
  }

  const accepted = [];
  const blocked = [];
  for (const [name, finding] of Object.entries(findings)) {
    if (severities.indexOf(finding.severity) < severities.indexOf('high')) continue;
    (excepted(name) ? accepted : blocked).push(name);
  }
  return { accepted, blocked };
}

export function readAuditResult(result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(
      `npm audit could not complete: ${result.error?.message || result.signal || result.status}`,
    );
  }
  const report = JSON.parse(result.stdout);
  if (report.error) throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);
  if (result.status === 1 && !Object.keys(report.vulnerabilities ?? {}).length) {
    throw new Error('npm audit failed without a vulnerability report');
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    // npm supplies its CLI path on every supported platform, including Windows.
    if (!process.env.npm_execpath) throw new Error('Run this check with npm run audit:ci');
    const result = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.stderr) process.stderr.write(result.stderr);
    const report = readAuditResult(result);
    // Keep the complete upstream findings visible, including accepted findings.
    console.log(JSON.stringify(report, null, 2));
    const { accepted, blocked } = evaluateAudit(
      report,
      JSON.parse(readFileSync('package-lock.json', 'utf8')),
    );
    if (accepted.length) {
      console.warn(
        `Temporary dev-only exception for ${advisory} (picomatch 4.0.7), expires 2026-12-01 UTC: ${accepted.join(', ')}`,
      );
    }
    if (blocked.length)
      throw new Error(`High/critical vulnerabilities require fixes: ${blocked.join(', ')}`);
    console.log('Dependency audit policy passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
