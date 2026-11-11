import { PATIENT_SEXES, REPRESENTATIVE_RELATIONS } from '@consultorio/contracts';
import { useWatch, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input, Select, Textarea } from '../../../shared/ui/input.js';
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';
import { isMinor, MAJORITY_AGE, type PatientFormValues } from '../domain/patient-form.js';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-4 rounded-lg border bg-card p-4 sm:p-5">
      <legend className="px-1 font-display text-base font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * The fields of a patient, shared by the registration and by the edit of the personal data. The
 * representative section appears when the birth date makes the patient a minor, and the consent
 * question only when registering.
 */
export function PatientFields({
  form,
  mode,
  today,
}: {
  form: UseFormReturn<PatientFormValues>;
  mode: 'create' | 'edit';
  today: Date;
}) {
  const { t } = useTranslation('patients');
  const birthDate = useWatch({ control: form.control, name: 'birthDate' });
  const documentType = useWatch({ control: form.control, name: 'documentType' });
  const minor = mode === 'create' && isMinor(birthDate, today);

  return (
    <div className="grid gap-5">
      <Section title={t('form.section.identity')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="familyName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.familyName')}</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="givenNames"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.givenNames')}</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="birthDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.birthDate')}</FormLabel>
                <FormControl>
                  <Input type="date" max={today.toISOString().slice(0, 10)} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="sex"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.sex')}</FormLabel>
                <FormControl>
                  <Select {...field}>
                    <option value="">{t('form.sex.none')}</option>
                    {PATIENT_SEXES.map((sex) => (
                      <option key={sex} value={sex}>
                        {t(`form.sex.${sex}`)}
                      </option>
                    ))}
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="documentType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.documentType')}</FormLabel>
                <FormControl>
                  <Select {...field}>
                    <option value="dni">{t('form.documentType.dni')}</option>
                    <option value="passport">{t('form.documentType.passport')}</option>
                    <option value="none">{t('form.documentType.none')}</option>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {documentType === 'none' ? null : (
            <FormField
              control={form.control}
              name="documentNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('form.documentNumber')}</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      inputMode={documentType === 'dni' ? 'numeric' : 'text'}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>{t(`form.documentHelp.${documentType}`)}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>
        {documentType === 'none' ? (
          <p className="text-sm text-muted-foreground">{t('form.documentHelp.none')}</p>
        ) : null}
      </Section>

      <Section title={t('form.section.contact')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.phone')}</FormLabel>
                <FormControl>
                  <Input type="tel" autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.email')}</FormLabel>
                <FormControl>
                  <Input type="email" inputMode="email" autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.address')}</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </Section>

      <Section title={t('form.section.emergency')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="emergencyName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.emergencyName')}</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="emergencyPhone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.emergencyPhone')}</FormLabel>
                <FormControl>
                  <Input type="tel" autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="adminNotes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.adminNotes')}</FormLabel>
              <FormControl>
                <Textarea {...field} />
              </FormControl>
              <FormDescription>{t('form.adminNotesHelp')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </Section>

      {minor ? (
        <Section title={t('form.section.representative')}>
          <p className="text-sm text-muted-foreground">
            {t('form.representativeIntro', { age: MAJORITY_AGE })}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="representativeName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('form.representativeName')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="representativeRelation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('form.representativeRelation')}</FormLabel>
                  <FormControl>
                    <Select {...field}>
                      <option value="">{t('form.representativeRelation.choose')}</option>
                      {REPRESENTATIVE_RELATIONS.map((relation) => (
                        <option key={relation} value={relation}>
                          {t(`representatives.relation.${relation}`)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="representativePhone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('form.representativePhone')}</FormLabel>
                  <FormControl>
                    <Input type="tel" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="representativeEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('form.representativeEmail')}</FormLabel>
                  <FormControl>
                    <Input type="email" inputMode="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <RepresentativeContactMessage form={form} />
        </Section>
      ) : null}

      {mode === 'create' ? (
        <Section title={t('form.section.consent')}>
          <FormField
            control={form.control}
            name="consent"
            render={({ field }) => (
              <FormItem>
                <p className="font-medium" id="consent-legend">
                  {t('form.consent.legend')}
                </p>
                <FormDescription>{t('form.consent.help')}</FormDescription>
                <RadioGroup
                  aria-labelledby="consent-legend"
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                  }}
                >
                  <RadioCard value="yes" title={t('form.consent.yes')} />
                  <RadioCard value="no" title={t('form.consent.no')} />
                </RadioGroup>
                <FormMessage />
              </FormItem>
            )}
          />
        </Section>
      ) : null}
    </div>
  );
}

/** The "phone or email" rule spans two fields, so its message has its own place. */
function RepresentativeContactMessage({ form }: { form: UseFormReturn<PatientFormValues> }) {
  const { t } = useTranslation('patients');
  const error = (form.formState.errors as Record<string, { message?: string } | undefined>)[
    'representativeContact'
  ];
  if (!error) return null;
  return (
    <p role="alert" className="text-sm font-medium text-destructive">
      {t('form.error.representativeContact')}
    </p>
  );
}
