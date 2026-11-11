import type { HtmlTagDescriptor, Plugin } from 'vite';

/**
 * The font file the sign-in page draws its text with: the Latin subset of Inter (every accent of
 * Spanish is in it). The stylesheet names it, so the browser would only ask for it once the page has
 * been laid out, and the text then swaps from the fallback font to Inter. The swap repaints the
 * text, and the repaint is what the browser reports as the largest contentful paint: one round trip
 * for the font, after everything else, sat on the critical path of the budget.
 */
const PRELOADED_FONT = /(?:^|\/)inter-latin-wght-normal-[\w-]+\.woff2$/;

/** The `<link rel="preload">` tags for the fonts found among the files of the build. */
export function fontPreloadTags(files: Iterable<string>, base = '/'): HtmlTagDescriptor[] {
  return [...files]
    .filter((file) => PRELOADED_FONT.test(file))
    .map((file) => ({
      tag: 'link',
      attrs: {
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        // Fonts are always fetched with CORS, so the preload must be too or the browser fetches twice.
        crossorigin: '',
        href: `${base}${file}`,
      },
      injectTo: 'head-prepend',
    }));
}

/** Preloads the font of the sign-in page in the built `index.html`. */
export function fontPreloadPlugin(): Plugin {
  let base = '/';
  return {
    name: 'consultorio:font-preload',
    apply: 'build',
    configResolved(config) {
      base = config.base.endsWith('/') ? config.base : `${config.base}/`;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        return fontPreloadTags(Object.keys(context.bundle ?? {}), base);
      },
    },
  };
}
