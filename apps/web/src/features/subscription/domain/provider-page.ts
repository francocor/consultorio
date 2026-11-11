/**
 * Sends the browser to a page of the payments provider (the hosted checkout, a payment link, the page
 * that asks to authorize a new amount). The person leaves the application on purpose: the provider
 * asks for the card, which this application never sees. One function, so a test can stand in for it.
 */
export function goToProviderPage(url: string): void {
  window.location.assign(url);
}
