import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluateAudit, readAuditResult } from '../../scripts/audit-dependencies.mjs';

const now = Date.parse('2026-11-17T18:00:00Z');
const advisory = {
  name: 'picomatch',
  dependency: 'picomatch',
  severity: 'high',
  range: '<=4.0.7',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
};
const causes = {
  picomatch: [advisory],
  fdir: ['picomatch'],
  tinyglobby: ['fdir', 'picomatch'],
  vite: ['picomatch', 'tinyglobby'],
  vitest: ['picomatch', 'tinyglobby', 'vite'],
  'svelte-check': ['fdir'],
  '@sveltejs/vite-plugin-svelte': ['vite'],
  '@sveltejs/kit': ['@sveltejs/vite-plugin-svelte', 'vite'],
  '@sveltejs/adapter-static': ['@sveltejs/kit'],
};
function fixture() {
  const report = {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      Object.entries(causes).map(([name, via]) => [
        name,
        {
          name,
          severity: 'high',
          via: structuredClone(via),
          nodes: [`node_modules/${name}`],
        },
      ]),
    ),
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 9, critical: 0 } },
  };
  const lock = {
    packages: Object.fromEntries(
      Object.keys(causes).map((name) => [
        `node_modules/${name}`,
        { dev: true, version: name === 'picomatch' ? '4.0.7' : '1.0.0' },
      ]),
    ),
  };
  return { report, lock };
}

describe('dependency audit policy', () => {
  it('accepts only the reviewed development chain and works with the committed lockfile', () => {
    const { report } = fixture();
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    expect(evaluateAudit(report, lock, now)).toEqual({
      accepted: Object.keys(causes),
      blocked: [],
    });
  });

  it.each([false, undefined])('blocks production/shared or unknown scope (%s)', (dev) => {
    const { report, lock } = fixture();
    lock.packages['node_modules/picomatch'].dev = dev;
    expect(evaluateAudit(report, lock, now).blocked).toHaveLength(9);
  });

  it('blocks a production parent even if its cause is a reviewed dev dependency', () => {
    const { report, lock } = fixture();
    lock.packages['node_modules/vite'].dev = false;
    expect(evaluateAudit(report, lock, now).blocked).toContain('vite');
  });

  it.each(['4.0.6', '4.0.8'])(
    'requires a fresh review for changed picomatch version %s',
    (version) => {
      const { report, lock } = fixture();
      lock.packages['node_modules/picomatch'].version = version;
      expect(evaluateAudit(report, lock, now).blocked).toHaveLength(9);
    },
  );

  it('blocks new advisories even in an otherwise excepted dependency chain', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.picomatch.via.push({
      ...advisory,
      url: 'https://github.com/advisories/NEW',
    });
    expect(evaluateAudit(report, lock, now).blocked).toHaveLength(9);
  });

  it('blocks a new direct advisory on a parent tool', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.vite.via.push({ ...advisory, name: 'vite', dependency: 'vite' });
    expect(evaluateAudit(report, lock, now).blocked).toContain('vite');
  });

  it('blocks new ranges and escalated severity', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.picomatch.via[0].range = '<=4.0.8';
    expect(evaluateAudit(report, lock, now).blocked).toHaveLength(9);
    report.vulnerabilities.picomatch.via[0] = { ...advisory, severity: 'critical' };
    report.vulnerabilities.picomatch.severity = 'critical';
    report.metadata.vulnerabilities.high = 8;
    report.metadata.vulnerabilities.critical = 1;
    expect(evaluateAudit(report, lock, now).blocked).toHaveLength(9);
  });

  it.each(['missing', 'nested', 'extra'])('blocks %s lockfile nodes', (kind) => {
    const { report, lock } = fixture();
    if (kind === 'missing') delete lock.packages['node_modules/picomatch'];
    else {
      const path = 'node_modules/vite/node_modules/picomatch';
      lock.packages[path] = { dev: true, version: '4.0.7' };
      report.vulnerabilities.picomatch.nodes =
        kind === 'nested' ? [path] : ['node_modules/picomatch', path];
    }
    expect(evaluateAudit(report, lock, now).blocked).toHaveLength(9);
  });

  it('blocks new tool consumers, missing causes and cycles', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.unreviewed = {
      name: 'unreviewed',
      severity: 'high',
      via: ['picomatch'],
      nodes: ['node_modules/unreviewed'],
    };
    lock.packages['node_modules/unreviewed'] = { dev: true, version: '1.0.0' };
    report.metadata.vulnerabilities.high++;
    expect(evaluateAudit(report, lock, now).blocked).toEqual(['unreviewed']);
    report.vulnerabilities.fdir.via = ['missing'];
    expect(evaluateAudit(report, lock, now).blocked).toContain('fdir');
    report.vulnerabilities.fdir.via = ['tinyglobby'];
    expect(evaluateAudit(report, lock, now).blocked).toContain('tinyglobby');
  });

  it('expires at the UTC boundary but allows a clean audit after expiry', () => {
    const { report, lock } = fixture();
    const expiry = Date.parse('2026-12-01T00:00:00Z');
    expect(evaluateAudit(report, lock, expiry - 1).blocked).toEqual([]);
    expect(evaluateAudit(report, lock, expiry).blocked).toHaveLength(9);
    report.vulnerabilities = {};
    report.metadata.vulnerabilities.high = 0;
    expect(evaluateAudit(report, lock, expiry).blocked).toEqual([]);
  });

  it('retains the high threshold for unrelated moderate findings', () => {
    const { report, lock } = fixture();
    report.vulnerabilities.vite.severity = 'moderate';
    report.metadata.vulnerabilities.high--;
    report.metadata.vulnerabilities.moderate++;
    expect(evaluateAudit(report, lock, now).blocked).not.toContain('vite');
  });

  it.each([null, {}, { error: { code: 'E503' } }, { auditReportVersion: 3 }])(
    'fails closed on invalid reports: %j',
    (report) => {
      expect(() => evaluateAudit(report, fixture().lock, now)).toThrow();
    },
  );

  it('rejects missing findings, metadata mismatches and empty cause lists', () => {
    const { report, lock } = fixture();
    report.metadata.vulnerabilities.high = 0;
    expect(() => evaluateAudit(report, lock, now)).toThrow('totals');
    report.metadata.vulnerabilities.high = 9;
    report.vulnerabilities.picomatch.via = [];
    expect(() => evaluateAudit(report, lock, now)).toThrow('finding');
  });

  it('distinguishes audit findings from registry, JSON and process failures', () => {
    const { report } = fixture();
    expect(readAuditResult({ status: 1, stdout: JSON.stringify(report) })).toEqual(report);
    for (const result of [
      { status: 1, stdout: JSON.stringify({ error: { code: 'E503' } }) },
      { status: 1, stdout: '{}' },
      { status: 0, stdout: '<html>error</html>' },
      { status: 2, stdout: JSON.stringify(report) },
      { status: null, signal: 'SIGTERM' },
      { error: new Error('ENOENT') },
    ])
      expect(() => readAuditResult(result)).toThrow();
  });
});
