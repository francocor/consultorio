/**
 * Where a window of the program may go. The window shows the clinical record, so it must never leave the
 * app by a link, a redirect, a frame or a script: the app's own pages stay in the window, a web address goes
 * to the browser of the PC, and everything else goes nowhere.
 *
 * Addresses are compared by their parsed origin. Comparing the start of the text is wrong:
 * `http://localhost:47800@evil.example/` begins with the app's address and is a page of evil.example.
 */

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isSameOrigin(url: string, appOrigin: string): boolean {
  const parsed = parse(url);
  return parsed !== null && parsed.origin === appOrigin && parsed.protocol === 'http:';
}

/** A plain web address a person could open in a browser: http or https, with no embedded credentials. */
function isExternalWeb(url: string): boolean {
  const parsed = parse(url);
  return (
    parsed !== null &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

export type NavigationDecision =
  { action: 'allow' } | { action: 'external'; url: string } | { action: 'block' };

/** What to do when a window (or a frame in it) is about to navigate, or was redirected, to `url`. */
export function decideNavigation(url: string, appOrigin: string): NavigationDecision {
  if (isSameOrigin(url, appOrigin)) return { action: 'allow' };
  if (isExternalWeb(url)) return { action: 'external', url };
  return { action: 'block' };
}

export type WindowOpenDecision = { action: 'deny'; openExternally?: string };

/** What to do when a page asks for a new window: never open one; a web address goes to the browser. */
export function decideWindowOpen(url: string, appOrigin: string): WindowOpenDecision {
  if (!isSameOrigin(url, appOrigin) && isExternalWeb(url)) {
    return { action: 'deny', openExternally: url };
  }
  return { action: 'deny' };
}
