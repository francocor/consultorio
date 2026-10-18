import type { Page } from '@playwright/test';

import { horizontalOverflow } from './stack.js';

/**
 * Content that a phone cannot reach. The width of the page says whether the page itself scrolls
 * sideways; this says whether something is wider than the box that holds it and that box cuts it
 * off (`overflow: hidden`), so the part outside is lost without the page showing any scrollbar.
 * A box with `overflow-x: auto` is fine: the person scrolls it.
 *
 * Returns a short description of the first elements found (tag, role or class, and how far they
 * stick out), empty when everything is reachable.
 */
export async function unreachableContent(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const clippingOf = (element: Element): Element | null => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX !== 'visible') return parent;
      }
      return null;
    };
    const describe = (element: Element) => {
      const text = element.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
      const cls = (element.getAttribute('class') ?? '').split(/\s+/).slice(0, 4).join('.');
      return `${element.tagName.toLowerCase()}${cls ? `.${cls}` : ''} "${text}"`;
    };
    const found: string[] = [];
    for (const element of document.querySelectorAll('main *, [role="dialog"] *')) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const clip = clippingOf(element);
      if (!clip || clip === document.documentElement || clip === document.body) continue;
      const overflow = getComputedStyle(clip).overflowX;
      // A scrollable box lets the person reach it.
      if (overflow === 'auto' || overflow === 'scroll') continue;
      const box = clip.getBoundingClientRect();
      // Text that is cut with an ellipsis is meant to be (its element is as wide as its box).
      if (rect.right > box.right + 1 && style.textOverflow !== 'ellipsis') {
        found.push(
          `${describe(element)} sticks out ${String(Math.round(rect.right - box.right))}px of ${describe(clip)}`,
        );
        if (found.length >= 5) break;
      }
    }
    return found;
  });
}

/** The page fits the phone and nothing in it is cut off. */
export async function layoutProblems(page: Page): Promise<string[]> {
  const sideways = await horizontalOverflow(page);
  return [
    ...(sideways > 0 ? [`the page is ${String(sideways)}px wider than the screen`] : []),
    ...(await unreachableContent(page)),
  ];
}
