import { describe, expect, it } from 'vitest';

import {
  newOpaqueRoomId,
  type VideoLinkProvider,
} from '../../modules/teleconsultation/application/ports.js';

/**
 * What every video provider adapter must do, whichever it is: the in-memory fake, the local
 * adapter (a public Jitsi server) and, later, Jitsi as a Service. Each adapter's test file calls
 * this with a factory. A real adapter that cannot pass it must not be registered.
 */
export function describeVideoLinkProviderContract(
  label: string,
  create: () => VideoLinkProvider,
): void {
  describe(`video link provider contract: ${label}`, () => {
    it('names itself and lists the hosts a manual link may use', () => {
      const provider = create();

      expect(provider.name).toMatch(/^[a-z][a-z0-9_-]*$/);
      for (const host of provider.manualLinkDomains) {
        expect(host).toBe(host.toLowerCase());
        expect(host).toMatch(/^[a-z0-9.-]+$/);
      }
    });

    it('reserves the room it is asked for, and asking twice gives the same room', async () => {
      const provider = create();
      const id = newOpaqueRoomId();

      const first = await provider.createRoom(id);
      const again = await provider.createRoom(id);

      expect(first).toEqual({ room: id });
      expect(again).toEqual(first);
    });

    it.each([
      ['a patient name', 'Ana Gomez'],
      ['an email address', 'ana@example.org'],
      ['a national identifier', '30123456'],
      ['an id that is too short', 'abc123'],
      ['an id in capitals', 'ABCDEFABCDEFABCDEFABCDEFABCDEFAB'],
      ['an empty id', ''],
    ])('refuses to send %s to the provider as a room name', async (_label, id) => {
      const provider = create();

      await expect(provider.createRoom(id)).rejects.toThrow(/opaque/i);
    });

    it('gives an https address for each room, different for different rooms', () => {
      const provider = create();
      const one = newOpaqueRoomId();
      const two = newOpaqueRoomId();

      const urlOne = new URL(provider.joinUrl(one));
      const urlTwo = new URL(provider.joinUrl(two));

      expect(urlOne.protocol).toBe('https:');
      expect(urlOne.pathname).toContain(one);
      expect(urlTwo.pathname).toContain(two);
      expect(urlOne.href).not.toBe(urlTwo.href);
      expect(provider.joinUrl(one)).toBe(urlOne.href);
    });

    it('never carries credentials or a query in the address', () => {
      const url = new URL(create().joinUrl(newOpaqueRoomId()));

      expect(url.username).toBe('');
      expect(url.password).toBe('');
      expect(url.search).toBe('');
    });
  });
}
