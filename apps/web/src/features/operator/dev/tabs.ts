import type { ComponentType } from 'react';

/**
 * A tab of the provider console. A feature adds one by creating
 * `features/operator/dev/<provider>/tab.tsx` that exports `tab`; nothing shared changes. The tab
 * holds the controls of one simulator (switch an outage on, send an inbound reply, mark a message
 * delivered).
 */
export interface DevTab {
  /** Unique, lowercase words joined by hyphens. */
  id: string;
  /** The translation key of the tab label, with its namespace: `messaging:dev.tab`. */
  labelKey: string;
  Component: ComponentType;
}

type TabModule = { tab: DevTab };

/** The tabs of the modules the build found, ordered by id. Two with the same id are an error. */
export function collectTabs(modules: Readonly<Record<string, TabModule>>): DevTab[] {
  const tabs: DevTab[] = [];
  for (const { tab } of Object.values(modules)) {
    if (tabs.some((known) => known.id === tab.id)) {
      throw new Error(`Two provider console tabs share the id "${tab.id}".`);
    }
    tabs.push(tab);
  }
  return tabs.sort((a, b) => a.id.localeCompare(b.id));
}

// Every tab.tsx one folder below features/operator/dev, found when the application is built.
export const REGISTERED_TABS: readonly DevTab[] = collectTabs(
  import.meta.glob<TabModule>('./*/tab.tsx', { eager: true }),
);
