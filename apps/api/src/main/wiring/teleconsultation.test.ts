import { describe, expect, it } from 'vitest';

import { DEFAULT_MANUAL_LINK_DOMAINS } from '../../adapters/video-local/index.js';
import { VideoProviderUnavailableError } from '../../modules/teleconsultation/application/ports.js';
import { loadConfig } from '../config.js';

import { teleconsultationWiring } from './teleconsultation.js';

const env = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

const slotFor = (overrides: Record<string, string> = {}) => {
  const config = loadConfig({ ...env, ...overrides });
  const registry = teleconsultationWiring.adapters?.({ config, db: {} as never });
  if (!registry?.videoLink) throw new Error('the wiring registers no videoLink slot');
  return registry.videoLink;
};

const PRODUCTION = {
  NODE_ENV: 'production',
  KMS_PROVIDER: 'aws',
  AWS_REGION: 'sa-east-1',
  AWS_KMS_KEY_ID: 'alias/consultorio',
  SMTP_HOST: 'email-smtp.sa-east-1.amazonaws.com',
  SMTP_SECURITY: 'starttls',
};

describe('the video slot of the adapter registry', () => {
  it('serves customers with the local provider while VIDEO_PROVIDER is local', () => {
    const slot = slotFor({ VIDEO_ALLOWED_DOMAINS: 'meet.google.com,zoom.us' });

    expect(slot.real?.adapter.name).toBe('local');
    expect(slot.real?.adapter.manualLinkDomains).toEqual(['meet.google.com', 'zoom.us']);
    expect(
      new URL(slot.real?.adapter.joinUrl('0f8a3c2e9b1d4a7f8c6e5d4b3a291807') ?? '').hostname,
    ).toBe('meet.jit.si');
  });

  it('builds the addresses on the video server VIDEO_LOCAL_BASE_URL names', () => {
    const slot = slotFor({ VIDEO_LOCAL_BASE_URL: 'https://jitsi.clinic.example' });
    const url = new URL(slot.real?.adapter.joinUrl('0f8a3c2e9b1d4a7f8c6e5d4b3a291807') ?? '');

    expect(url.hostname).toBe('jitsi.clinic.example');
    expect(url.pathname).toBe('/0f8a3c2e9b1d4a7f8c6e5d4b3a291807');
  });

  it('hands a demo organization the fake, whatever the customers get', () => {
    const slot = slotFor();

    expect(slot.demo.kind).toBe('fake');
    expect(slot.demo.adapter.name).toBe('fake');
  });

  it('lets the simulators accept the usual video services when the platform lists no host', () => {
    const slot = slotFor();

    expect(slot.real?.adapter.manualLinkDomains).toEqual(DEFAULT_MANUAL_LINK_DOMAINS);
    expect(slot.demo.adapter.manualLinkDomains).toEqual(DEFAULT_MANUAL_LINK_DOMAINS);
    expect(DEFAULT_MANUAL_LINK_DOMAINS).toContain('meet.google.com');
  });

  it('gives a demo organization the hosts the platform lists, like customers', () => {
    const slot = slotFor({ VIDEO_ALLOWED_DOMAINS: 'zoom.us' });

    expect(slot.demo.adapter.manualLinkDomains).toEqual(['zoom.us']);
    expect(slot.real?.adapter.manualLinkDomains).toEqual(['zoom.us']);
  });

  it('cannot make a room for customers when video is off, but keeps the manual link hosts', async () => {
    const slot = slotFor({
      ...PRODUCTION,
      VIDEO_PROVIDER: 'off',
      WHATSAPP_PROVIDER: 'off',
      BOT_CHALLENGE: 'turnstile',
      VIDEO_ALLOWED_DOMAINS: 'zoom.us',
    });

    expect(slot.real?.adapter.name).toBe('unavailable');
    expect(slot.real?.adapter.manualLinkDomains).toEqual(['zoom.us']);
    await expect(
      slot.real?.adapter.createRoom('0f8a3c2e9b1d4a7f8c6e5d4b3a291807'),
    ).rejects.toBeInstanceOf(VideoProviderUnavailableError);
  });

  it('treats the Jitsi as a Service selection as unavailable until its adapter exists (task 3.82)', () => {
    const slot = slotFor({
      ...PRODUCTION,
      VIDEO_PROVIDER: 'jaas',
      WHATSAPP_PROVIDER: 'off',
      BOT_CHALLENGE: 'turnstile',
    });

    expect(slot.real?.adapter.name).toBe('unavailable');
  });
});
