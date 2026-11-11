import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrastRatio } from '../shared/lib/contrast.js';

const css = readFileSync(resolve(import.meta.dirname, 'tokens.css'), 'utf8');

/** Reads `--name: #hex;` declarations of one selector block. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf('\n}', start);
  const body = css.slice(start, end);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[match[1] ?? ''] = match[2] ?? '';
  }
  return tokens;
}

const light = block(':root');
const dark = { ...light, ...block('.dark') };

/** [foreground, background] pairs that carry text. */
const TEXT_PAIRS: [string, string][] = [
  ['--foreground', '--background'],
  ['--card-foreground', '--card'],
  ['--popover-foreground', '--popover'],
  ['--muted-foreground', '--background'],
  ['--muted-foreground', '--card'],
  ['--muted-foreground', '--muted'],
  ['--primary-foreground', '--primary'],
  ['--secondary-foreground', '--secondary'],
  ['--accent-foreground', '--accent'],
  ['--destructive-foreground', '--destructive'],
  ['--success-foreground', '--success'],
  ['--success-soft-foreground', '--success-soft'],
  ['--warning-foreground', '--warning'],
  ['--warning-soft-foreground', '--warning-soft'],
  ['--info-foreground', '--info'],
  ['--info-soft-foreground', '--info-soft'],
  ['--danger-soft-foreground', '--danger-soft'],
  ['--sidebar-foreground', '--sidebar'],
];

/** Edges and indicators that must be distinguishable (3:1). */
const UI_PAIRS: [string, string][] = [
  ['--input', '--background'],
  ['--input', '--card'],
  ['--ring', '--background'],
  ['--ring', '--card'],
];

describe('design tokens: contrast of every pair', () => {
  it('reads the tokens it is going to check', () => {
    expect(Object.keys(light).length).toBeGreaterThan(25);
    expect(Object.keys(block('.dark')).length).toBeGreaterThan(20);
  });

  for (const [name, tokens] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it.each(TEXT_PAIRS)(`${name}: text %s on %s reaches 4.5:1`, (foreground, background) => {
      const ratio = contrastRatio(tokens[foreground] ?? '', tokens[background] ?? '');
      expect(ratio, `${name} ${foreground} on ${background}`).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it.each(UI_PAIRS)(`${name}: edge %s on %s reaches 3:1`, (edge, surface) => {
      const color = edge === '--ring' ? (tokens['--primary'] ?? '') : (tokens[edge] ?? '');
      const ratio = contrastRatio(color, tokens[surface] ?? '');
      expect(ratio, `${name} ${edge} on ${surface}`).toBeGreaterThanOrEqual(AA_UI);
    });
  }

  it('the checker really fails a bad pair (so a passing run means something)', () => {
    expect(contrastRatio('#94a3b8', '#ffffff')).toBeLessThan(AA_UI);
  });
});
