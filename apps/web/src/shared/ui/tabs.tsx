import { Tabs as TabsPrimitive } from 'radix-ui';
import { useCallback, useEffect, useRef, type ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

/**
 * `min-w-0` lets the tabs shrink to the column they sit in. As the child of a grid or flex box they
 * would otherwise be as wide as their widest content (a table, a long label) and push the page past
 * the screen of a phone instead of letting that content scroll or wrap.
 */
export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn('min-w-0', className)} {...props} />;
}

/** Space left between the open tab and the edge of the row when the row scrolls to show it. */
const REVEAL_MARGIN = 8;

/**
 * Scrolls the row so the whole of the open tab is in view. Only the row moves: the page does not
 * (`scrollIntoView` would also scroll the page).
 */
export function revealActiveTab(row: HTMLElement): void {
  const active = row.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
  if (!active) return;
  const tab = active.getBoundingClientRect();
  const strip = row.getBoundingClientRect();
  if (tab.left < strip.left) {
    row.scrollLeft -= strip.left - tab.left + REVEAL_MARGIN;
  } else if (tab.right > strip.right) {
    row.scrollLeft += tab.right - strip.right + REVEAL_MARGIN;
  }
}

/**
 * The row of tabs. When there are more than the width shows, the row scrolls sideways (it never
 * wraps into a second line of pills, and never widens the page), the tab that is open is always
 * brought into view, and each tab keeps its own size (see `TabsTrigger`).
 */
export function TabsList({ className, ref, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  const row = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      row.current = element;
      if (typeof ref === 'function') ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );

  useEffect(() => {
    const element = row.current;
    if (!element) return;
    revealActiveTab(element);
    // The open tab changes by a click, the keyboard, a link to the tab or a feature adding tabs.
    const observer = new MutationObserver(() => {
      revealActiveTab(element);
    });
    observer.observe(element, {
      attributes: true,
      attributeFilter: ['data-state'],
      childList: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <TabsPrimitive.List
      ref={setRef}
      className={cn(
        'inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        // `shrink-0`: in a row that scrolls, a tab that shrinks is a box narrower than its own
        // label, and a click on the label lands on the box next to it.
        'touch-target-md inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors',
        'hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
        'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('mt-4', className)} {...props} />;
}
