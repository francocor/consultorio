import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Tabs, TabsList, TabsTrigger, revealActiveTab } from './tabs.js';

/** Boxes of a row of tabs, since jsdom lays nothing out. */
function layout(
  row: HTMLElement,
  strip: [number, number],
  tabs: Record<string, [number, number] | undefined>,
) {
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
    left: strip[0],
    right: strip[1],
  } as DOMRect);
  for (const tab of screen.getAllByRole('tab')) {
    const box = tabs[tab.textContent] ?? [0, 0];
    vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue({
      left: box[0],
      right: box[1],
    } as DOMRect);
  }
}

function renderTabs(value: string) {
  return render(
    <Tabs defaultValue={value}>
      <TabsList aria-label="Secciones">
        <TabsTrigger value="a">Uno</TabsTrigger>
        <TabsTrigger value="b">Dos</TabsTrigger>
        <TabsTrigger value="c">Tres</TabsTrigger>
      </TabsList>
    </Tabs>,
  );
}

describe('the row of tabs', () => {
  it('lets no tab shrink below its label, so a click on the label is a click on the tab', () => {
    renderTabs('a');

    for (const tab of screen.getAllByRole('tab')) expect(tab.className).toContain('shrink-0');
  });

  it('scrolls to the right to show an open tab that is cut off, leaving a margin', () => {
    renderTabs('c');
    const row = screen.getByRole('tablist');
    layout(row, [16, 344], { Uno: [20, 64], Dos: [68, 112], Tres: [340, 400] });

    revealActiveTab(row);

    expect(row.scrollLeft).toBe(400 - 344 + 8);
  });

  it('does not move when the open tab is already inside the row', () => {
    renderTabs('b');
    const row = screen.getByRole('tablist');
    layout(row, [16, 344], { Uno: [20, 64], Dos: [68, 112], Tres: [116, 160] });

    revealActiveTab(row);

    expect(row.scrollLeft).toBe(0);
  });

  it('scrolls back to the left when the open tab is hidden before the start of the row', () => {
    renderTabs('a');
    const row = screen.getByRole('tablist');
    row.scrollLeft = 200;
    layout(row, [16, 344], { Uno: [-100, -56], Dos: [68, 112], Tres: [116, 160] });

    revealActiveTab(row);

    expect(row.scrollLeft).toBe(200 - (16 - -100 + 8));
  });

  it('reveals the tab that a click opens', async () => {
    const user = userEvent.setup();
    renderTabs('a');
    const row = screen.getByRole('tablist');
    layout(row, [16, 344], { Uno: [20, 64], Dos: [68, 112], Tres: [340, 400] });

    await user.click(screen.getByRole('tab', { name: 'Tres' }));

    await vi.waitFor(() => {
      expect(row.scrollLeft).toBe(64);
    });
  });
});
