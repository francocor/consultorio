# Design system

How the web app looks and why. The tokens live in `apps/web/src/styles/tokens.css`, the components in `apps/web/src/shared/ui`, and a test (`tokens.test.ts`) checks the contrast of every foreground/background pair in light and dark.

## Direction

A calm clinical product for health professionals in Argentina: quiet slate neutrals, one confident brand color, and a lot of whitespace. The goal is that a receptionist or a doctor understands a screen in a few seconds and never has to think about the interface.

- **Light first, dark supported.** The color scheme follows the device unless the person picks one (user menu).
- **Borders over shadows.** Surfaces are separated by 1 px borders; shadows are only used for floating layers (menus, dialogs).
- **Radius up to 8 px** by default (`--radius: 6px`). A tenant may choose a rounder look from a curated set.
- **Type.** Inter (variable) for text, with tabular numbers for times and money. The heading family is a tenant choice from a curated set (Inter, Source Sans 3, Poppins, Lora, Merriweather). All fonts are self-hosted: no request leaves for a font CDN.
- **Status is never color alone.** Every status has an icon and a word (`StatusBadge`, `SafetyFlag`).
- **Touch.** Controls are at least 44 px high on phones and 40 px from the tablet breakpoint; interactive rows never rely on hover.

## Run of `ui-ux-pro-max`

Command (task 1.100):

```
python ~/.claude/skills/ui-ux-pro-max/scripts/search.py "health clinic SaaS scheduling" --design-system -p "Aillu"
```

What it returned, and what was taken from it:

| Output                                                                                                    | Decision                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pattern "Hero + Testimonials + CTA" (a landing page pattern)                                              | **Not used.** This is an application, not a marketing page.                                                                                                                                                                               |
| Style "Neumorphism" (soft embossed surfaces), flagged `accessibility: risk:high`                          | **Rejected.** Low-contrast edges fail WCAG 1.4.11 and clash with the design rule "borders over shadows". The product keeps flat surfaces with clear borders.                                                                              |
| Palette: calm cyan `#0891B2` with health green `#059669`, text `#164E63`                                  | **Taken as the mood, not the values.** `#0891B2` on white is only 3.7:1, so the default brand is teal `#0F766E` (5.5:1 with white text). The status colors follow the same calm family.                                                   |
| Typography: Atkinson Hyperlegible (accessible, dyslexia friendly)                                         | **Considered, not adopted as default.** The design decision (section 8 of the design) is Inter with tabular numbers, which is better for tables of times and money. Legibility is covered by 16 px text, 1.5 line height and AA contrast. |
| Checklist: no emoji icons (Lucide), `cursor-pointer`, visible focus, reduced motion, 375/768/1024/1440 px | **Adopted**: Lucide icons only, visible 2 px focus ring, `prefers-reduced-motion`, and the layouts are verified at 360 and 1280 px.                                                                                                       |

## Tokens

Semantic CSS variables in the shadcn convention. Components read them through Tailwind (`bg-card`, `text-muted-foreground`, `border-input`...) and never use a raw color.

| Group    | Tokens                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------- |
| Surfaces | `background`, `card`, `popover`, `muted`, `secondary`, `accent`, `sidebar`                         |
| Text     | `foreground`, `muted-foreground`, and the `*-foreground` of each surface                           |
| Edges    | `border` (decorative), `input` (the edge of a control, 3:1), `ring` (focus, follows the brand)     |
| Brand    | `primary`, `primary-foreground`, `primary-ink` (the brand as text/ink; lightened in dark mode)     |
| Status   | `success`, `warning`, `info`, `destructive`, plus a `*-soft` background/foreground pair for badges |
| Shape    | `--radius` (and `sm`, `md`, `lg`, `xl` derived from it)                                            |
| Type     | `--font-sans` (Inter), `--font-heading` (tenant choice)                                            |

### Per-tenant theme

The boot payload (`GET /public/boot`) carries `primary`, `primaryForeground`, `radius` and `headingFont`. `theme-boot.ts` turns them into `--primary`, `--primary-foreground`, `--ring`, `--radius` and `--font-heading` on `<html>` **before the first paint** (an inline script built from the same module). The server already guarantees 4.5:1 between the primary and its foreground (it adjusts the color in OKLCH and keeps the requested value), so every tenant theme is accessible by construction.

Presets (`packages/contracts/src/branding-presets.ts`, re-exported by `shared/ui/themes/consultorio.ts`): the neutral product look, **Aillu** (the legacy green `#03a550` with Poppins and rounder corners, used by the demo organization), and two more that show the range.

## Components

shadcn/ui components copied into `shared/ui` (Radix primitives, Tailwind 4, `class-variance-authority`):

Button, Input, Textarea, Label, Checkbox, Switch, Select, Dialog, Sheet, Tabs, Toast (Sonner), Table, Skeleton, Badge, Card, DropdownMenu, Form (react-hook-form wrappers with the label, description and error wired for assistive technology).

Product components:

| Component                                                   | Use                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PageHeader`                                                | Title, description and actions of every screen, one `h1` per page                     |
| `EmptyState`                                                | Says what the screen is for and offers the primary next action                        |
| `ErrorState`                                                | Plain-language failure with a retry button and the reference code to quote to support |
| `ForbiddenState`                                            | "No access" for a direct URL the role cannot use; nothing is fetched                  |
| `LoadingSkeleton`                                           | Placeholders with the shape of the content, announced as loading                      |
| `OfflineBanner`, `ReadOnlyBanner`, `TwoFactorRequiredState` | Global states driven by real signals (device offline, 402, enrollment 403)            |
| `StatusBadge`                                               | Icon + text status, never color alone                                                 |
| `SafetyFlag`                                                | Clinical alert chip; non-professionals see only "see professional"                    |

## Layout

One `AppShell` for all staff roles: a collapsible sidebar from the tablet breakpoint, a bottom navigation with at most five entries plus "More" on phones. The navigation is derived from the permissions the API returns, so hiding an entry is a convenience, never the protection. The patient portal and the public booking pages have their own minimal shells (Stage 2 and later).

## Accessibility checklist (WCAG 2.2 AA)

- Contrast: tokens are tested; the tenant primary is guaranteed by the server.
- Keyboard: every action reachable, visible focus (2 px ring, 2 px offset), skip link to the main content.
- Names: icon-only buttons have a label; inputs have a visible label; errors are linked with `aria-describedby`.
- Motion: `prefers-reduced-motion` removes transitions and animations.
- Targets: 44 px on phones.
- Verified by axe in Vitest (components) and Playwright (screens at 360 and 1280 px).
