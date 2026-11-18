import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function probeSettings(browserOnly = false, env = process.env) {
  const participants = Number(env.ANAGRAM_CALL_TEST_PARTICIPANTS || (browserOnly ? 6 : 4));
  const scenario = env.ANAGRAM_CALL_TEST_SCENARIO || 'all';
  const media = env.ANAGRAM_CALL_TEST_MEDIA || 'video';
  if (!['audio', 'video'].includes(media)) throw new Error('Choose audio or video call media');
  if (!['all', 'direct', 'group', 'legacy'].includes(scenario))
    throw new Error('Choose all, direct, group or legacy call scenarios');
  if (!Number.isInteger(participants) || participants < 2 || participants > 6)
    throw new Error('Choose 2 to 6 test participants');
  return { participants, scenario, media, browserOnly, platform: process.platform };
}

export function createBuildConfig(settings) {
  return { ...settings, token: randomUUID() };
}

export async function readBuildConfig(path, settings) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (
    !config ||
    Object.entries(settings).some(([key, value]) => config[key] !== value) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.token)
  )
    throw new Error('Native build configuration does not match this test run; rebuild first');
  return config;
}

export function probeUrl({ token, browserOnly, participants, scenario, media }) {
  return `http://127.0.0.1:5189/__native_calls?token=${token}&native=${browserOnly ? 0 : 1}&participants=${participants}&scenario=${scenario}&media=${media}`;
}
