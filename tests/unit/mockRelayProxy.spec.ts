import { describe, expect, it } from 'vitest';
import {
  calculateDelayMs,
  classifyRelayMessage,
  parseCommandLineArguments,
  resolveMockRelayConfig,
  resolveRelayResponseBehavior,
} from '../../scripts/mock-relay-proxy.cjs';

describe('mock relay proxy', () => {
  it('uses a shared delay unless a relay phase overrides it', () => {
    const config = resolveMockRelayConfig(
      {},
      {
        MOCK_RELAY_DELAY_MS: '700',
        MOCK_RELAY_ACK_DELAY_MS: '1200',
        MOCK_RELAY_DROP_EOSE: 'true',
        MOCK_RELAY_HANG_MODE: 'none',
      }
    );

    expect(config).toMatchObject({
      handshakeDelayMs: 700,
      requestDelayMs: 700,
      ackDelayMs: 1200,
      eventDelayMs: 700,
      eoseDelayMs: 700,
      dropEose: true,
    });
  });

  it('rejects invalid delay and hang settings', () => {
    expect(() => resolveMockRelayConfig({}, { MOCK_RELAY_ACK_DELAY_MS: '-1' })).toThrow(
      'MOCK_RELAY_ACK_DELAY_MS'
    );
    expect(() => resolveMockRelayConfig({}, { MOCK_RELAY_HANG_MODE: 'sometimes' })).toThrow(
      'MOCK_RELAY_HANG_MODE'
    );
  });

  it.each([
    ['["OK","event-id",true,""]', 'ack'],
    ['["EVENT","subscription",{}]', 'event'],
    ['["EOSE","subscription"]', 'eose'],
    ['["NOTICE","maintenance"]', 'other'],
    ['not-json', 'other'],
  ])('classifies %s as %s', (message, expectedType) => {
    expect(classifyRelayMessage(message)).toBe(expectedType);
  });

  it('applies per-message delay, jitter, and drop behavior', () => {
    const config = resolveMockRelayConfig(
      {
        ackDelayMs: 200,
        eventDelayMs: 300,
        eoseDelayMs: 400,
        jitterMs: 100,
        dropAcks: true,
      },
      {}
    );

    expect(resolveRelayResponseBehavior('["OK","id",true,""]', config, () => 0.5)).toEqual({
      delayMs: 250,
      messageType: 'ack',
      shouldDrop: true,
    });
    expect(resolveRelayResponseBehavior('["EVENT","sub",{}]', config, () => 0)).toEqual({
      delayMs: 300,
      messageType: 'event',
      shouldDrop: false,
    });
  });

  it('drops every relay response in response-hang mode', () => {
    const config = resolveMockRelayConfig({ hangMode: 'responses' }, {});

    expect(resolveRelayResponseBehavior('["NOTICE","waiting"]', config)).toMatchObject({
      messageType: 'other',
      shouldDrop: true,
    });
  });

  it('parses standalone command-line settings', () => {
    expect(
      parseCommandLineArguments([
        '--target',
        'ws://relay.example:8080',
        '--ack-delay-ms',
        '2500',
        '--drop-eose',
        '--verbose',
      ])
    ).toEqual({
      targetUrl: 'ws://relay.example:8080',
      ackDelayMs: '2500',
      dropEose: true,
      verbose: true,
    });
  });

  it('adds inclusive bounded jitter', () => {
    expect(calculateDelayMs(100, 20, () => 0)).toBe(100);
    expect(calculateDelayMs(100, 20, () => 0.999)).toBe(120);
  });
});
