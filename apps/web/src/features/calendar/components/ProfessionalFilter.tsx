import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';
import type { SchedulingProfessional } from '../containers/use-scheduling-people.js';

function Chip({
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
        'touch-target-md inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full border px-3.5 text-sm font-medium',
        pressed
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-card hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Who is on the agenda: everybody the person may see, or the professionals chosen. A row of
 * toggles that wraps (and scrolls on a phone), so choosing is one tap.
 */
export function ProfessionalFilter({
  professionals,
  selected,
  onChange,
}: {
  professionals: readonly SchedulingProfessional[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation('scheduling');

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  }

  return (
    <div
      role="group"
      aria-label={t('filter.professionals')}
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap"
    >
      <Chip
        pressed={selected.length === 0}
        onClick={() => {
          onChange([]);
        }}
      >
        {t('filter.everyone')}
      </Chip>
      {professionals.map((professional) => (
        <Chip
          key={professional.id}
          pressed={selected.includes(professional.id)}
          onClick={() => {
            toggle(professional.id);
          }}
        >
          {professional.name}
        </Chip>
      ))}
    </div>
  );
}
