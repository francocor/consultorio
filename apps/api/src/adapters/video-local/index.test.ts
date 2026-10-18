import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoProviderUnavailableError } from '../../modules/teleconsultation/application/ports.js';
import { createFakeVideoLinkProvider } from '../video-fake/index.js';

import { describeVideoLinkProviderContract } from './video.contract.js';

import { createLocalVideoLinkProvider, createUnavailableVideoLinkProvider } from './index.js';

describeVideoLinkProviderContract('fake', () => createFakeVideoLinkProvider());
describeVideoLinkProviderContract('local', () => createLocalVideoLinkProvider());

const ROOM = '0f8a3c2e9b1d4a7f8c6e5d4b3a291807';

describe('local video link provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the address on the public Jitsi server by default, which needs no account', () => {
    const url = new URL(createLocalVideoLinkProvider().joinUrl(ROOM));

    expect(url.origin).toBe('https://meet.jit.si');
    expect(url.pathname).toBe(`/${ROOM}`);
  });

  it('starts muted and never records or streams: the settings travel in the address fragment', () => {
    const url = new URL(createLocalVideoLinkProvider().joinUrl(ROOM));
    const settings = new URLSearchParams(url.hash.slice(1));

    expect(settings.get('config.startWithAudioMuted')).toBe('true');
    expect(settings.get('config.startWithVideoMuted')).toBe('true');
    expect(settings.get('config.fileRecordingsEnabled')).toBe('false');
    expect(settings.get('config.liveStreamingEnabled')).toBe('false');
    expect(settings.get('config.localRecording.disable')).toBe('true');
  });

  it('uses a self-hosted Jitsi when one is given, with or without a trailing slash', () => {
    const plain = createLocalVideoLinkProvider({ baseUrl: 'https://jitsi.clinica.example' });
    const slash = createLocalVideoLinkProvider({ baseUrl: 'https://jitsi.clinica.example/' });

    expect(new URL(plain.joinUrl(ROOM)).origin).toBe('https://jitsi.clinica.example');
    expect(new URL(slash.joinUrl(ROOM)).pathname).toBe(`/${ROOM}`);
  });

  it.each([
    ['plain http', 'http://jitsi.clinica.example'],
    ['credentials', 'https://user:pass@jitsi.clinica.example'],
    ['a query', 'https://jitsi.clinica.example/?room=x'],
    ['not an address', 'jitsi'],
  ])('refuses a base address with %s', (_label, baseUrl) => {
    expect(() => createLocalVideoLinkProvider({ baseUrl })).toThrow(/base/i);
  });

  it('keeps the allowed manual link hosts it was given, in lower case', () => {
    const provider = createLocalVideoLinkProvider({
      allowedDomains: ['Meet.Google.com', 'zoom.us'],
    });

    expect(provider.manualLinkDomains).toEqual(['meet.google.com', 'zoom.us']);
    expect(provider.name).toBe('local');
  });

  it('creates a room without calling anything: the server makes the room when the first person arrives', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const room = await createLocalVideoLinkProvider().createRoom(ROOM);

    expect(room).toEqual({ room: ROOM });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('unavailable video link provider', () => {
  it('cannot make a room or an address, and says so with a typed error', async () => {
    const provider = createUnavailableVideoLinkProvider({ allowedDomains: ['Zoom.us'] });

    await expect(provider.createRoom(ROOM)).rejects.toBeInstanceOf(VideoProviderUnavailableError);
    expect(() => provider.joinUrl(ROOM)).toThrow(VideoProviderUnavailableError);
  });

  it('still knows the hosts a manual link may use, so a platform without video accepts them', () => {
    const provider = createUnavailableVideoLinkProvider({
      allowedDomains: ['Zoom.us', 'meet.google.com'],
    });

    expect(provider.name).toBe('unavailable');
    expect(provider.manualLinkDomains).toEqual(['zoom.us', 'meet.google.com']);
    expect(createUnavailableVideoLinkProvider().manualLinkDomains).toEqual([]);
  });
});
