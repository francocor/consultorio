import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';
import { Button } from '../../../shared/ui/button.js';
import type { CalendarViewMode } from '../../../shared/ui/calendar/zoned-time.js';

const VIEWS: readonly CalendarViewMode[] = ['day', 'week', 'month'];

/** One segment of a group of mutually exclusive buttons (a view, a presentation). */
export function Segment({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'touch-target-md inline-flex cursor-pointer items-center justify-center px-3 text-sm font-medium transition-colors',
        pressed ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Where the agenda is: previous, today, next, the period in words, and the view. The period is
 * announced politely when it changes, so a screen reader hears where the person landed.
 */
export function CalendarToolbar({
  view,
  period,
  wide,
  list,
  onView,
  onList,
  onPrevious,
  onNext,
  onToday,
}: {
  view: CalendarViewMode;
  period: string;
  wide: boolean;
  list: boolean;
  onView: (view: CalendarViewMode) => void;
  onList: (list: boolean) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  const { t } = useTranslation('scheduling');

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          onClick={onPrevious}
          aria-label={t(`toolbar.previous.${view}`)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button variant="outline" onClick={onToday}>
          {t('toolbar.today')}
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={onNext}
          aria-label={t(`toolbar.next.${view}`)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>

      <p
        aria-live="polite"
        className="min-w-0 flex-1 basis-40 font-display text-lg font-semibold first-letter:uppercase"
      >
        {period}
      </p>

      <div
        role="group"
        aria-label={t('toolbar.view')}
        className="inline-flex divide-x overflow-hidden rounded-md border border-input"
      >
        {VIEWS.map((option) => (
          <Segment
            key={option}
            pressed={view === option}
            onClick={() => {
              onView(option);
            }}
          >
            {t(`toolbar.views.${option}`)}
          </Segment>
        ))}
      </div>

      {wide && view !== 'month' ? (
        <div
          role="group"
          aria-label={t('toolbar.presentation')}
          className="inline-flex divide-x overflow-hidden rounded-md border border-input"
        >
          <Segment
            pressed={!list}
            onClick={() => {
              onList(false);
            }}
          >
            {t('toolbar.grid')}
          </Segment>
          <Segment
            pressed={list}
            onClick={() => {
              onList(true);
            }}
          >
            {t('toolbar.list')}
          </Segment>
        </div>
      ) : null}
    </div>
  );
}
