import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * One line of the appointment card: an icon, what it is and its value. A description list wants
 * `dt` and `dd` as the only children of each group, so the icon lives inside the term.
 */
export function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {label}
      </dt>
      <dd className="pl-6 font-medium">{children}</dd>
    </div>
  );
}
