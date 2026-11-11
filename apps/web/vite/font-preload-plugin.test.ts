import { describe, expect, it } from 'vitest';

import { fontPreloadPlugin, fontPreloadTags } from './font-preload-plugin.js';

const FILES = [
  'assets/app-XO66Gctv.js',
  'assets/inter-latin-wght-normal-Dx4kXJAl.woff2',
  'assets/inter-latin-ext-wght-normal-DO1Apj_S.woff2',
  'assets/inter-cyrillic-wght-normal-AbCd.woff2',
  'assets/merriweather-latin-wght-normal-BovdrKvB.woff2',
  'icons/icon-192.png',
];

describe('the preload of the font of the sign-in page', () => {
  it('names the Latin subset of Inter and no other font', () => {
    const tags = fontPreloadTags(FILES);

    expect(tags).toHaveLength(1);
    expect(tags[0]?.attrs?.['href']).toBe('/assets/inter-latin-wght-normal-Dx4kXJAl.woff2');
  });

  it('asks for it the way the stylesheet will: a font, with CORS, so the browser fetches it once', () => {
    expect(fontPreloadTags(FILES)[0]).toMatchObject({
      tag: 'link',
      attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '' },
      injectTo: 'head-prepend',
    });
  });

  it('follows the base of the application', () => {
    expect(fontPreloadTags(FILES, '/app/')[0]?.attrs?.['href']).toBe(
      '/app/assets/inter-latin-wght-normal-Dx4kXJAl.woff2',
    );
  });

  it('adds nothing when the build has no such font', () => {
    expect(fontPreloadTags(['assets/app.js'])).toEqual([]);
  });

  it('only runs in the build, where the file names are known', () => {
    expect(fontPreloadPlugin().apply).toBe('build');
  });
});
