import { describe, expect, it } from 'vitest';

import type { Tx } from '../../../platform/db/tenant-context.js';

import {
  createVideoJoinRegistry,
  videoNoteOf,
  type VideoJoin,
  type VideoJoinResolver,
} from './video-join.js';

const tx = {} as Tx;
const answering = (join: VideoJoin): VideoJoinResolver => ({
  resolve: () => Promise.resolve(join),
});

describe('the video join registry', () => {
  it('answers "pending" until teleconsultation registers its resolver', async () => {
    const registry = createVideoJoinRegistry();

    await expect(registry.resolver.resolve(tx, 'a')).resolves.toEqual({ kind: 'pending' });
  });

  it('asks the registered resolver, whenever it was registered', async () => {
    const registry = createVideoJoinRegistry();
    const { resolver } = registry;
    const expiresAt = new Date('2031-05-20T00:00:00Z');
    registry.register(answering({ kind: 'link', url: 'https://x.test/public/v/T', expiresAt }));

    await expect(resolver.resolve(tx, 'a')).resolves.toEqual({
      kind: 'link',
      url: 'https://x.test/public/v/T',
      expiresAt,
    });
  });

  it('passes the appointment on', async () => {
    const registry = createVideoJoinRegistry();
    const asked: string[] = [];
    registry.register({
      resolve: (_tx, appointmentId) => {
        asked.push(appointmentId);
        return Promise.resolve({ kind: 'in_person' });
      },
    });

    await registry.resolver.resolve(tx, 'appointment-1');

    expect(asked).toEqual(['appointment-1']);
  });

  it('refuses a second resolver instead of replacing the first', () => {
    const registry = createVideoJoinRegistry();
    registry.register(answering({ kind: 'closed' }));

    expect(() => registry.register(answering({ kind: 'closed' }))).toThrow(/already registered/);
  });

  it('lets another resolver in after the first one was removed', async () => {
    const registry = createVideoJoinRegistry();
    const remove = registry.register(answering({ kind: 'closed' }));
    remove();

    await expect(registry.resolver.resolve(tx, 'a')).resolves.toEqual({ kind: 'pending' });
    expect(() => registry.register(answering({ kind: 'in_person' }))).not.toThrow();
  });
});

describe('what a message says about the call', () => {
  it('carries the address', () => {
    const note = videoNoteOf({
      kind: 'link',
      url: 'https://x.test/public/v/T',
      expiresAt: new Date(),
    });

    expect(note).toEqual({ kind: 'link', url: 'https://x.test/public/v/T' });
  });

  it('says the link follows while there is none', () => {
    expect(videoNoteOf({ kind: 'pending' })).toEqual({ kind: 'pending' });
  });

  it('says nothing for an in-person appointment or a call that is over', () => {
    expect(videoNoteOf({ kind: 'in_person' })).toBeUndefined();
    expect(videoNoteOf({ kind: 'closed' })).toBeUndefined();
  });
});
