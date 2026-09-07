const { execFileSync } = require('node:child_process');

const MINIMUM_GIT_SHA_LENGTH = 12;

function normalizeAppGitSha(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${MINIMUM_GIT_SHA_LENGTH},}$`).test(normalized)) {
    return null;
  }

  return normalized.slice(0, MINIMUM_GIT_SHA_LENGTH);
}

function readGitSha(projectRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function resolveAppGitSha({ appGitSha, isProduction, readFallbackSha }) {
  const suppliedSha = typeof appGitSha === 'string' ? appGitSha.trim() : '';
  if (suppliedSha) {
    const normalizedSha = normalizeAppGitSha(suppliedSha);
    if (normalizedSha) {
      return normalizedSha;
    }

    if (isProduction) {
      throw new Error(
        `APP_GIT_SHA must contain at least ${MINIMUM_GIT_SHA_LENGTH} hexadecimal characters for production builds.`
      );
    }
  }

  const fallbackSha = normalizeAppGitSha(readFallbackSha?.());
  if (fallbackSha) {
    return fallbackSha;
  }

  if (isProduction) {
    throw new Error(
      'Production builds require APP_GIT_SHA or a resolvable Git commit SHA; refusing to use "unknown".'
    );
  }

  return 'unknown';
}

module.exports = {
  normalizeAppGitSha,
  readGitSha,
  resolveAppGitSha,
};
