import type {
  VideoLinkProvider,
  VideoRoom,
} from '../../modules/teleconsultation/application/ports.js';

export interface FakeVideoLinkProvider extends VideoLinkProvider {
  /** Every room reserved, oldest first. */
  readonly rooms: readonly string[];
}

/** `.invalid` never resolves (RFC 2606): a fake address cannot reach a real service. */
const FAKE_BASE_URL = 'https://video.example.invalid';

/**
 * Video provider for tests and demo organizations (design section 6: "static URL"). Rooms are
 * remembered only so a test can see which ones were asked for.
 */
export function createFakeVideoLinkProvider(): FakeVideoLinkProvider {
  const rooms: string[] = [];

  return {
    get rooms() {
      return rooms;
    },
    createRoom(opaqueId): Promise<VideoRoom> {
      if (!rooms.includes(opaqueId)) rooms.push(opaqueId);
      return Promise.resolve({ room: opaqueId });
    },
    joinUrl(room) {
      return `${FAKE_BASE_URL}/${room}`;
    },
  };
}
