import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewReleaseAudit } from '../../scripts/audit-release.mjs';

const withdrawn = {
  name: 'picomatch',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
};
const other = { name: 'picomatch', url: 'https://github.com/advisories/GHSA-other' };
const finding = (via: unknown[], severity = 'high') => ({ via, severity });
const report = (vulnerabilities: Record<string, ReturnType<typeof finding>>) => ({
  auditReportVersion: 2,
  vulnerabilities,
  metadata: {
    vulnerabilities: {
      ...Object.fromEntries(
        ['info', 'low', 'moderate', 'high', 'critical'].map((severity) => [
          severity,
          Object.values(vulnerabilities).filter((v) => v.severity === severity).length,
        ]),
      ),
      total: Object.keys(vulnerabilities).length,
    },
  },
});
const withdrawnTree = () =>
  report({
    picomatch: finding([withdrawn]),
    fdir: finding(['picomatch']),
    'svelte-check': finding(['fdir']),
    tinyglobby: finding(['fdir', 'picomatch']),
    vite: finding(['picomatch', 'tinyglobby']),
    '@sveltejs/vite-plugin-svelte': finding(['vite']),
    '@sveltejs/kit': finding(['@sveltejs/vite-plugin-svelte', 'vite']),
    '@sveltejs/adapter-static': finding(['@sveltejs/kit']),
    vitest: finding(['picomatch', 'vite', 'tinyglobby']),
  });

it('accepts a clean report and exempts all nine packages affected only by the withdrawn advisory', () => {
  expect(reviewReleaseAudit(report({}))).toEqual({ failures: [], ignored: [] });
  const result = reviewReleaseAudit(withdrawnTree());
  expect(result.failures).toEqual([]);
  expect(result.ignored).toHaveLength(9);
});

it('blocks a new picomatch advisory and all affected dependents', () => {
  const audit = withdrawnTree();
  audit.vulnerabilities.picomatch.via.push(other);
  expect(reviewReleaseAudit(audit).failures).toHaveLength(9);
  expect(reviewReleaseAudit(audit).ignored).toEqual([]);
});

it('blocks unrelated critical findings and mixed paths while preserving the high threshold', () => {
  expect(
    reviewReleaseAudit(
      report({
        picomatch: finding([withdrawn]),
        other: finding([other], 'critical'),
        vite: finding(['picomatch', 'other']),
        moderate: finding([other], 'moderate'),
      }),
    ),
  ).toEqual({ failures: ['other', 'vite'], ignored: ['picomatch'] });
});

it('does not exempt another package using the same URL, missing causes, or cycles', () => {
  expect(
    reviewReleaseAudit(
      report({
        other: finding([{ ...withdrawn, name: 'other' }]),
        missing: finding(['absent']),
        empty: finding([]),
        cyclic: finding(['cyclic']),
      }),
    ).failures,
  ).toEqual(['other', 'missing', 'empty', 'cyclic']);
});

it('rejects incomplete, inconsistent and failed audit reports', () => {
  for (const invalid of [
    {},
    { error: { code: 'E503' } },
    { auditReportVersion: 1 },
    { ...report({}), error: { code: 'E503' } },
    { ...withdrawnTree(), vulnerabilities: {} },
    report({ unknown: finding([], 'unknown') }),
  ])
    expect(() => reviewReleaseAudit(invalid)).toThrow();
});

it('enforces the policy in the release command and fails on registry or JSON errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anagram-release-audit-'));
  try {
    writeFileSync(
      join(dir, 'npm'),
      '#!/bin/sh\nprintf "%s" "$AUDIT_FIXTURE"\nexit "$AUDIT_STATUS"\n',
      { mode: 0o755 },
    );
    for (const [fixture, status, expected] of [
      [JSON.stringify(report({})), '0', 0],
      [JSON.stringify(withdrawnTree()), '1', 0],
      [JSON.stringify(report({ picomatch: finding([withdrawn, other]) })), '1', 1],
      [JSON.stringify({ error: { code: 'E503' } }), '1', 1],
      ['not JSON', '0', 1],
      [JSON.stringify(report({})), '2', 1],
    ] as const) {
      const result = spawnSync(process.execPath, [resolve('scripts/audit-release.mjs')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          AUDIT_FIXTURE: fixture,
          AUDIT_STATUS: status,
        },
      });
      expect(result.status, result.stderr).toBe(expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
