import type { Locator, Page } from '@playwright/test';

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

/**
 * Buttons, links and tabs whose own label is wider than the control: a chip squeezed by its row
 * (`flex-shrink`) shows "Todo" for "Todos" and half a name, and nothing else on the page reports
 * it, because the row scrolls and the page does not move. A control that ellipsizes on purpose
 * (`text-overflow: ellipsis`) and one with no text (a switch, a checkbox) are left out.
 */
export async function clippedLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const selector = 'main button, main a[href], main [role="tab"], header button, header a[href]';
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const label = element.textContent.trim().replace(/\s+/g, ' ');
      if (label === '' || element.clientWidth === 0) continue;
      if (style.textOverflow === 'ellipsis') continue;
      if (element.scrollWidth > element.clientWidth + 1) {
        found.push(
          `"${label.slice(0, 40)}" needs ${String(element.scrollWidth)}px and has ${String(element.clientWidth)}px`,
        );
      }
    }
    return found.slice(0, 5);
  });
}

/**
 * How tall the area is that answers a tap on a control, measured the way a finger finds it: from
 * the middle of the control, up and down, until another element answers. A hit area that is wider
 * than the visible box (a `::after` that grows it) counts; the box alone does not tell.
 */
export async function hitHeight(control: Locator): Promise<number> {
  return control.evaluate((element) => {
    // Centered, so neither the bar at the top nor the one at the bottom covers it.
    element.scrollIntoView({ block: 'center' });
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const middle = box.top + box.height / 2;
    const answers = (y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === element || element.contains(hit));
    };
    let up = 0;
    while (up < 60 && answers(middle - up - 1)) up += 1;
    let down = 0;
    while (down < 60 && answers(middle + down)) down += 1;
    return up + down;
  });
}

/** Boxes of two sets of elements that cover each other (text that sits under a button). */
export async function overlappingBoxes(
  page: Page,
  containerSelector: string,
  controlSelector: string,
): Promise<string[]> {
  return page.evaluate(
    ([containerQuery, controlQuery]) => {
      const found: string[] = [];
      const overlaps = (a: DOMRect, b: DOMRect) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4;
      for (const container of document.querySelectorAll(containerQuery ?? '')) {
        for (const control of container.querySelectorAll(controlQuery ?? '')) {
          const controlBox = control.getBoundingClientRect();
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent?.trim() === '' || control.contains(node)) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            if ([...range.getClientRects()].some((rect) => overlaps(controlBox, rect))) {
              found.push(
                `"${control.textContent.trim().slice(0, 30)}" covers "${node.textContent?.trim().slice(0, 30) ?? ''}"`,
              );
            }
          }
        }
      }
      return found.slice(0, 5);
    },
    [containerSelector, controlSelector],
  );
}
