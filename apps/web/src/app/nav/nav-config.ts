import type { Permission, Role } from '@consultorio/contracts';
import {
  Banknote,
  BarChart3,
  CalendarDays,
  CreditCard,
  FilePen,
  House,
  ListTodo,
  Pill,
  ScrollText,
  Settings,
  Stethoscope,
  UserRoundCheck,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

/**
 * The navigation, derived from what the API says the user can do. Hiding an entry is only a
 * convenience: every route repeats the check (`RequirePermission`) and the API enforces it.
 *
 * Entries that belong to a later stage are defined now so the layouts are reviewed as a whole, and
 * switch on when `ENABLED_STAGE` is raised; until then they are not shown (no dead links).
 */
export const ENABLED_STAGE = 2;

/**
 * Entries of the enabled stage whose screens are not built yet. They stay out of the navigation
 * (no dead links) and leave this list as their slices land.
 */
const NOT_BUILT_YET: ReadonlySet<NavId> = new Set([
  'today',
  'check-in',
  'worklist',
  'drafts',
  'prescriptions',
]);

export type NavId =
  | 'home'
  | 'today'
  | 'calendar'
  | 'check-in'
  | 'worklist'
  | 'patients'
  | 'drafts'
  | 'prescriptions'
  | 'cash'
  | 'staff'
  | 'reports'
  | 'billing'
  | 'audit'
  | 'settings';

export interface NavItem {
  id: NavId;
  to: string;
  /** Key in the `shell` catalog. */
  labelKey: `nav.${NavId}`;
  icon: LucideIcon;
  /** The stage in which the screen ships. */
  stage: number;
  /** The user needs any one of these; empty means everyone who is signed in. */
  anyOf: readonly Permission[];
}

export const NAV_ITEMS: Record<NavId, NavItem> = {
  home: { id: 'home', to: '/', labelKey: 'nav.home', icon: House, stage: 1, anyOf: [] },
  today: {
    id: 'today',
    to: '/today',
    labelKey: 'nav.today',
    icon: Stethoscope,
    stage: 2,
    anyOf: ['scheduling.read'],
  },
  calendar: {
    id: 'calendar',
    to: '/calendar',
    labelKey: 'nav.calendar',
    icon: CalendarDays,
    stage: 2,
    anyOf: ['scheduling.read'],
  },
  'check-in': {
    id: 'check-in',
    to: '/check-in',
    labelKey: 'nav.check-in',
    icon: UserRoundCheck,
    stage: 2,
    anyOf: ['scheduling.checkin'],
  },
  worklist: {
    id: 'worklist',
    to: '/worklist',
    labelKey: 'nav.worklist',
    icon: ListTodo,
    stage: 2,
    anyOf: ['scheduling.checkin'],
  },
  patients: {
    id: 'patients',
    to: '/patients',
    labelKey: 'nav.patients',
    icon: Users,
    stage: 1,
    anyOf: ['patients.read'],
  },
  drafts: {
    id: 'drafts',
    to: '/drafts',
    labelKey: 'nav.drafts',
    icon: FilePen,
    stage: 2,
    anyOf: ['clinical.note.write'],
  },
  prescriptions: {
    id: 'prescriptions',
    to: '/prescriptions',
    labelKey: 'nav.prescriptions',
    icon: Pill,
    stage: 2,
    anyOf: ['clinical.prescription.read'],
  },
  cash: {
    id: 'cash',
    to: '/cash',
    labelKey: 'nav.cash',
    icon: Banknote,
    stage: 4,
    anyOf: ['cash.operate'],
  },
  staff: {
    id: 'staff',
    to: '/staff',
    labelKey: 'nav.staff',
    icon: UsersRound,
    stage: 1,
    anyOf: ['staff.manage'],
  },
  reports: {
    id: 'reports',
    to: '/reports',
    labelKey: 'nav.reports',
    icon: BarChart3,
    stage: 3,
    anyOf: ['reports.read'],
  },
  billing: {
    id: 'billing',
    to: '/billing',
    labelKey: 'nav.billing',
    icon: CreditCard,
    stage: 6,
    anyOf: ['billing.manage'],
  },
  audit: {
    id: 'audit',
    to: '/audit',
    labelKey: 'nav.audit',
    icon: ScrollText,
    stage: 1,
    anyOf: ['audit.read'],
  },
  settings: {
    id: 'settings',
    to: '/settings',
    labelKey: 'nav.settings',
    icon: Settings,
    stage: 1,
    anyOf: ['tenant.settings.manage', 'tenant.branding.manage', 'locations.manage'],
  },
};

type Layout = 'professional' | 'reception' | 'admin';

/** The order of each role's area (design, section 8). */
const LAYOUTS: Record<Layout, readonly NavId[]> = {
  professional: ['today', 'patients', 'drafts', 'prescriptions'],
  reception: ['calendar', 'check-in', 'worklist', 'patients', 'cash'],
  admin: ['calendar', 'patients', 'staff', 'reports', 'billing', 'audit', 'settings'],
};

const LAYOUT_OF_ROLE: Partial<Record<Role, Layout>> = {
  professional: 'professional',
  reception: 'reception',
  owner: 'admin',
  admin: 'admin',
};

const LAYOUT_ORDER: readonly Layout[] = ['professional', 'reception', 'admin'];

export interface NavOptions {
  permissions: readonly Permission[];
  roles: readonly Role[];
  stage?: number;
}

/** The entries this user sees, in order: home first, then the areas of each of their roles. */
export function buildNav({ permissions, roles, stage = ENABLED_STAGE }: NavOptions): NavItem[] {
  const layouts = new Set(roles.flatMap((role) => LAYOUT_OF_ROLE[role] ?? []));
  const ids = ['home', ...LAYOUT_ORDER.filter((l) => layouts.has(l)).flatMap((l) => LAYOUTS[l])];
  const granted = new Set<Permission>(permissions);

  const seen = new Set<NavId>();
  const items: NavItem[] = [];
  for (const id of ids as NavId[]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = NAV_ITEMS[id];
    if (item.stage > stage) continue;
    if (stage <= ENABLED_STAGE && NOT_BUILT_YET.has(id)) continue;
    if (item.anyOf.length > 0 && !item.anyOf.some((permission) => granted.has(permission)))
      continue;
    items.push(item);
  }
  return items;
}

/** The phone's bottom bar holds at most five entries: with more, four plus "More". */
const BOTTOM_BAR_MAX = 5;

export function splitForMobile<T>(items: readonly T[]): { primary: T[]; more: T[] } {
  if (items.length <= BOTTOM_BAR_MAX) return { primary: [...items], more: [] };
  return { primary: items.slice(0, BOTTOM_BAR_MAX - 1), more: items.slice(BOTTOM_BAR_MAX - 1) };
}
