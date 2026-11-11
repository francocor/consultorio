import { z } from 'zod';

import { freeText } from './common.js';

/**
 * Nutrition visit (clinical-records, "Nutrition template"): weight, height, waist, dietary habits,
 * allergies and intolerances, goals and a meal plan. The body mass index is COMPUTED, never
 * entered: the schemas are strict, so a note that carries a `bmi` field is refused.
 *
 * Weight and height must be positive and plausible. A value outside the limits needs the
 * professional's explicit confirmation (`confirmImplausible`), so a slipped decimal point is
 * caught without blocking a real, unusual patient.
 */
export const PLAUSIBLE_LIMITS = {
  weightKg: { min: 2, max: 400 },
  heightM: { min: 0.4, max: 2.5 },
  waistCm: { min: 20, max: 300 },
} as const;

const Weight = z.number().positive().max(1000);
const Height = z.number().positive().max(100);

const fields = {
  waistCm: z.number().positive().max(1000).optional(),
  dietaryHabits: freeText(2000).optional(),
  allergiesIntolerances: freeText(2000).optional(),
  goals: freeText(2000).optional(),
  mealPlan: freeText(6000).optional(),
  /** The professional looked at an unusual value and confirms it is right. */
  confirmImplausible: z.boolean().optional(),
};

interface Measures {
  weightKg?: number | undefined;
  heightM?: number | undefined;
  waistCm?: number | undefined;
  confirmImplausible?: boolean | undefined;
}

function outside(value: number | undefined, limits: { min: number; max: number }): boolean {
  return value !== undefined && (value < limits.min || value > limits.max);
}

function checkPlausible(content: Measures, ctx: z.RefinementCtx): void {
  if (content.confirmImplausible === true) return;
  const measures: [keyof typeof PLAUSIBLE_LIMITS, number | undefined][] = [
    ['weightKg', content.weightKg],
    ['heightM', content.heightM],
    ['waistCm', content.waistCm],
  ];
  for (const [field, value] of measures) {
    if (outside(value, PLAUSIBLE_LIMITS[field])) {
      ctx.addIssue({ code: 'custom', path: [field], message: 'clinical.nutrition.implausible' });
    }
  }
}

export const NutritionDraft = z
  .strictObject({ weightKg: Weight.optional(), heightM: Height.optional(), ...fields })
  .superRefine(checkPlausible);

export const NutritionContent = z
  .strictObject({ weightKg: Weight, heightM: Height, ...fields })
  .superRefine(checkPlausible);
export type NutritionContent = z.infer<typeof NutritionContent>;

/** Body mass index with one decimal; null when either measure is missing or not positive. */
export function computeBmi(
  weightKg: number | undefined,
  heightM: number | undefined,
): number | null {
  if (weightKg === undefined || heightM === undefined || weightKg <= 0 || heightM <= 0) {
    return null;
  }
  return Math.round((weightKg / (heightM * heightM)) * 10) / 10;
}
