import { expect, it } from 'vitest';
import {
  CallAudioQueue,
  CALL_AUDIO_BACKLOG_MS,
  CALL_AUDIO_QUEUE_FRAMES,
} from '#src/services/callAudioQueue.ts';

it('retains every frame in order through a short scheduling stall', () => {
  const queue = new CallAudioQueue<number>();
  for (let i = 0; i < 20; i++) queue.push(i, i * 20);
  for (let i = 0; i < 20; i++) expect(queue.shift(500)).toBe(i);
  expect(queue.shift(500)).toBeUndefined();
});

it('bounds an overloaded consumer and drops only entries past the emergency limits', () => {
  const queue = new CallAudioQueue<number>();
  for (let i = 0; i < CALL_AUDIO_QUEUE_FRAMES + 5; i++) queue.push(i, 0);
  for (let i = 5; i < CALL_AUDIO_QUEUE_FRAMES + 5; i++) expect(queue.shift(0)).toBe(i);
  expect(queue.shift(0)).toBeUndefined();
  queue.push(1, 0);
  queue.push(2, CALL_AUDIO_BACKLOG_MS);
  expect(queue.shift(CALL_AUDIO_BACKLOG_MS + 1)).toBe(2);
  expect(queue.shift(CALL_AUDIO_BACKLOG_MS + 1)).toBeUndefined();
});

it('clears queued speech when its stream closes', () => {
  const queue = new CallAudioQueue<number>();
  queue.push(1, 0);
  queue.clear();
  expect(queue.shift(0)).toBeUndefined();
  queue.push(2, 0);
  expect(queue.shift(0)).toBe(2);
});

it('keeps the original capture age across successive queues', () => {
  const encoded = new CallAudioQueue<number>(),
    sending = new CallAudioQueue<number>();
  encoded.push(1, 500, 0);
  const packet = encoded.shift(1000)!;
  sending.push(packet, 1000, 0);
  expect(sending.ageMs(1400)).toBe(1400);
  expect(sending.shift(1501)).toBeUndefined();
  sending.push(2, 2000, 0);
  expect(sending.length).toBe(0);
});
