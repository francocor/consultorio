import { useEffect, useState } from 'react';

/**
 * A QR code drawn as an SVG image. The library loads on demand (only this screen needs it) and
 * runs in the browser: the secret in the link never goes to a third-party service.
 */
export function QrCode({ value, alt }: { value: string; alt: string }) {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void import('qrcode').then(async ({ toString }) => {
      const svg = await toString(value, { type: 'svg', margin: 1, width: 192 });
      if (current) setSource(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    });
    return () => {
      current = false;
    };
  }, [value]);

  return source ? (
    <img
      src={source}
      alt={alt}
      width={192}
      height={192}
      className="rounded-md border bg-white p-2"
    />
  ) : (
    <div aria-hidden="true" className="size-48 animate-pulse rounded-md bg-muted" />
  );
}
