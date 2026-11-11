import { describe, expect, it } from 'vitest';

import { createFakeVideoLinkProvider } from './index.js';

describe('fake video link provider', () => {
  it('reserves the room it is asked for, and the same room twice is the same room', async () => {
    const provider = createFakeVideoLinkProvider();

    const first = await provider.createRoom('0f8a3c2e9b1d4a7f8c6e5d4b3a291807');
    const again = await provider.createRoom('0f8a3c2e9b1d4a7f8c6e5d4b3a291807');
    const other = await provider.createRoom('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(first).toEqual({ room: '0f8a3c2e9b1d4a7f8c6e5d4b3a291807' });
    expect(again).toEqual(first);
    expect(other.room).not.toBe(first.room);
    expect(provider.rooms).toEqual([
      '0f8a3c2e9b1d4a7f8c6e5d4b3a291807',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
  });

  it('gives a static address per room that can never reach a real service', () => {
    const provider = createFakeVideoLinkProvider();

    const url = provider.joinUrl('room-1');

    expect(url).toBe('https://video.example.invalid/room-1');
    expect(new URL(url).hostname.endsWith('.invalid')).toBe(true);
    expect(provider.joinUrl('room-2')).toBe('https://video.example.invalid/room-2');
  });
});
