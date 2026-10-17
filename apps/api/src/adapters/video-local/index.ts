import {
  InvalidRoomNameError,
  isOpaqueRoomId,
  VideoProviderUnavailableError,
  type VideoLinkProvider,
  type VideoRoom,
} from '../../modules/teleconsultation/application/ports.js';

/**
 * The public Jitsi server needs no account, so the product works with video from the first day. A
 * self-hosted Jitsi can be given later through the same base address.
 */
export const DEFAULT_VIDEO_BASE_URL = 'https://meet.jit.si';

/**
 * Jitsi reads these from the address fragment, which the browser never sends to the server: the
 * room starts with microphone and camera off, and neither recording nor streaming is offered.
 */
const ROOM_SETTINGS = new URLSearchParams({
  'config.startWithAudioMuted': 'true',
  'config.startWithVideoMuted': 'true',
  'config.fileRecordingsEnabled': 'false',
  'config.liveStreamingEnabled': 'false',
  'config.localRecording.disable': 'true',
}).toString();

/**
 * The hosts a manual link may use while the simulators run and the platform lists none
 * (`VIDEO_ALLOWED_DOMAINS` empty): the public Jitsi server and the services professionals already
 * use. Production with a real provider, or with video off, has no default: an empty list there
 * allows nothing until the platform names its hosts.
 */
export const DEFAULT_MANUAL_LINK_DOMAINS: readonly string[] = [
  'meet.jit.si',
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
];

export interface LocalVideoOptions {
  /** Where the Jitsi server is. Defaults to the public one. */
  baseUrl?: string;
  /** `VIDEO_ALLOWED_DOMAINS`: the hosts a manual link may point at. */
  allowedDomains?: readonly string[];
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The video base address is not an address.');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('The video base address must be https and carry no credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('The video base address must carry no query or fragment.');
  }
  return url;
}

/**
 * Video provider for `VIDEO_PROVIDER=local`: it builds the address of a room on a Jitsi server.
 * Creating a room calls nothing, because Jitsi makes the room when the first person arrives; the
 * 128-bit random name is what keeps the room private. The address starts the call muted and
 * unrecorded.
 */
export function createLocalVideoLinkProvider(options: LocalVideoOptions = {}): VideoLinkProvider {
  const base = parseBaseUrl(options.baseUrl ?? DEFAULT_VIDEO_BASE_URL);
  const prefix = base.href.replace(/\/+$/, '');

  return {
    name: 'local',
    manualLinkDomains: (options.allowedDomains ?? []).map((host) => host.toLowerCase()),
    createRoom(opaqueId): Promise<VideoRoom> {
      if (!isOpaqueRoomId(opaqueId)) return Promise.reject(new InvalidRoomNameError());
      return Promise.resolve({ room: opaqueId });
    },
    joinUrl(room) {
      return `${prefix}/${room}#${ROOM_SETTINGS}`;
    },
  };
}

/**
 * The provider of a platform that has video switched off (`VIDEO_PROVIDER=off`, or a real provider
 * whose adapter does not exist yet). It cannot make a room, so every virtual appointment waits for
 * a manual link; it still knows which hosts a manual link may use.
 */
export function createUnavailableVideoLinkProvider(
  options: { allowedDomains?: readonly string[] } = {},
): VideoLinkProvider {
  return {
    name: 'unavailable',
    manualLinkDomains: (options.allowedDomains ?? []).map((host) => host.toLowerCase()),
    createRoom() {
      return Promise.reject(new VideoProviderUnavailableError());
    },
    joinUrl() {
      throw new VideoProviderUnavailableError();
    },
  };
}
