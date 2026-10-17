import type { CoverageDto, CoverageInput, PayerPlanDto } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeartPulse, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { formatCalendarDay } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { StatusBadge } from '../../../shared/ui/states/status-badge.js';
import { toast } from '../../../shared/ui/toaster.js';
import { patientKeys, patientsApi } from '../api/patients-api.js';

import { Section } from './Section.js';

/** Obra social, prepaga or self-pay: what the patient is covered by and which one is the default. */
export function CoverageTab({ patientId, canWrite }: { patientId: string; canWrite: boolean }) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const coverages = useQuery({
    queryKey: patientKeys.coverages(patientId),
    queryFn: () => patientsApi(api).coverages(patientId),
  });

  const changed = async () => {
    await queryClient.invalidateQueries({ queryKey: patientKeys.coverages(patientId) });
  };
  const remove = useMutation({
    mutationFn: (coverageId: string) => patientsApi(api).removeCoverage(patientId, coverageId),
    onSuccess: async () => {
      toast.success(t('patients:coverage.removed'));
      await changed();
    },
    onError: (error) => {
      toast.error(describeError(t, error).message);
    },
  });
  const makePrimary = useMutation({
    mutationFn: (coverageId: string) => patientsApi(api).makeCoveragePrimary(patientId, coverageId),
    onSuccess: changed,
    onError: (error) => {
      toast.error(describeError(t, error).message);
    },
  });

  if (coverages.isPending) return <ListSkeleton rows={2} />;
  if (coverages.isError) {
    return (
      <ErrorState
        error={coverages.error}
        onRetry={() => {
          void coverages.refetch();
        }}
      />
    );
  }
  const items = coverages.data.coverages;
  const addButton = canWrite ? (
    <Button
      onClick={() => {
        setAdding(true);
      }}
    >
      <Plus aria-hidden="true" />
      {t('patients:coverage.add')}
    </Button>
  ) : null;

  return (
    <>
      {items.length === 0 ? (
        <EmptyState
          icon={HeartPulse}
          title={t('patients:coverage.empty')}
          description={t('patients:coverage.description')}
          action={addButton}
        />
      ) : (
        <Section
          title={t('patients:coverage.title')}
          description={t('patients:coverage.description')}
          action={addButton}
        >
          <ul className="grid gap-3">
            {items.map((coverage) => (
              <CoverageItem
                key={coverage.id}
                coverage={coverage}
                canWrite={canWrite}
                onRemove={() => {
                  remove.mutate(coverage.id);
                }}
                onMakePrimary={() => {
                  makePrimary.mutate(coverage.id);
                }}
              />
            ))}
          </ul>
        </Section>
      )}
      <AddCoverageDialog patientId={patientId} open={adding} onOpenChange={setAdding} />
    </>
  );
}

function CoverageItem({
  coverage,
  canWrite,
  onRemove,
  onMakePrimary,
}: {
  coverage: CoverageDto;
  canWrite: boolean;
  onRemove: () => void;
  onMakePrimary: () => void;
}) {
  const { t } = useTranslation('patients');
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border p-3 sm:p-4">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{coverage.payerName}</span>
          {coverage.primary ? <Badge tone="brand">{t('coverage.primary')}</Badge> : null}
          {coverage.expired ? (
            <StatusBadge status="warning">{t('coverage.expired')}</StatusBadge>
          ) : null}
        </div>
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
          {coverage.planName ? (
            <span>{t('coverage.plan', { plan: coverage.planName })}</span>
          ) : null}
          {coverage.memberNumber ? (
            <span className="tabular">
              {t('coverage.number', { number: coverage.memberNumber })}
            </span>
          ) : null}
          {coverage.validTo ? (
            <span>{t('coverage.validTo', { date: formatCalendarDay(coverage.validTo) })}</span>
          ) : null}
        </p>
      </div>
      {canWrite ? (
        <div className="flex shrink-0 items-center gap-1">
          {coverage.primary ? null : (
            <Button variant="ghost" size="sm" onClick={onMakePrimary}>
              {t('coverage.makePrimary')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('coverage.remove', { name: coverage.payerName })}
            onClick={onRemove}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function planLabel(plan: PayerPlanDto): string {
  return plan.planName ? `${plan.name} - ${plan.planName}` : plan.name;
}

function buildSchema(plans: readonly PayerPlanDto[]) {
  return z
    .object({
      payerPlanId: z.string(),
      memberNumber: z.string().trim().max(40),
      validTo: z.string(),
      primary: z.boolean(),
    })
    .superRefine((values, ctx) => {
      const plan = plans.find((candidate) => candidate.id === values.payerPlanId);
      if (!plan) {
        ctx.addIssue({ code: 'custom', path: ['payerPlanId'], message: 'validation.required' });
      } else if (plan.kind !== 'private' && values.memberNumber === '') {
        ctx.addIssue({ code: 'custom', path: ['memberNumber'], message: 'validation.required' });
      }
    });
}
type Values = z.infer<ReturnType<typeof buildSchema>>;

function AddCoverageDialog({
  patientId,
  open,
  onOpenChange,
}: {
  patientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const plans = useQuery({
    queryKey: patientKeys.payerPlans,
    queryFn: () => patientsApi(api).payerPlans(),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('patients:coverage.form.title')}</DialogTitle>
          <DialogDescription>{t('patients:coverage.description')}</DialogDescription>
        </DialogHeader>
        {plans.isPending ? (
          <ListSkeleton rows={2} />
        ) : plans.isError ? (
          <ErrorState
            error={plans.error}
            onRetry={() => {
              void plans.refetch();
            }}
          />
        ) : (
          <AddCoverageForm
            patientId={patientId}
            plans={plans.data.filter((plan) => plan.active)}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddCoverageForm({
  patientId,
  plans,
  onDone,
}: {
  patientId: string;
  plans: readonly PayerPlanDto[];
  onDone: () => void;
}) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const schema = useMemo(() => buildSchema(plans), [plans]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { payerPlanId: '', memberNumber: '', validTo: '', primary: false },
  });
  const selectedId = useWatch({ control: form.control, name: 'payerPlanId' });
  const selected = plans.find((plan) => plan.id === selectedId);

  const add = useMutation({
    mutationFn: (values: Values) => {
      const body: CoverageInput = {
        payerPlanId: values.payerPlanId,
        ...(values.memberNumber === '' ? {} : { memberNumber: values.memberNumber }),
        ...(values.validTo === '' ? {} : { validTo: values.validTo }),
        ...(values.primary ? { primary: true } : {}),
      };
      return patientsApi(api).addCoverage(patientId, body);
    },
    onSuccess: async () => {
      toast.success(t('patients:coverage.saved'));
      onDone();
      await queryClient.invalidateQueries({ queryKey: patientKeys.coverages(patientId) });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });

  if (plans.length === 0) {
    return (
      <Alert tone="info">
        <AlertDescription>{t('patients:coverage.form.noPlans')}</AlertDescription>
      </Alert>
    );
  }
  const failed = add.isError && fieldErrorCount(add.error) === 0;

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            add.mutate(values);
          })(event);
        }}
      >
        {failed ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, add.error).message}</AlertDescription>
          </Alert>
        ) : null}
        <FormField
          control={form.control}
          name="payerPlanId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('patients:coverage.form.payer')}</FormLabel>
              <FormControl>
                <Select {...field}>
                  <option value="">{t('patients:coverage.form.choose')}</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {planLabel(plan)}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {selected?.kind === 'private' ? null : (
          <FormField
            control={form.control}
            name="memberNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('patients:coverage.form.memberNumber')}</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormDescription>{t('patients:coverage.form.memberNumberHelp')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <FormField
          control={form.control}
          name="validTo"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('patients:coverage.form.validTo')}</FormLabel>
              <FormControl>
                <Input type="date" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="primary"
          render={({ field }) => (
            <CheckboxCard
              checked={field.value}
              onCheckedChange={field.onChange}
              title={t('patients:coverage.form.primary')}
            />
          )}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            {t('common:action.cancel')}
          </Button>
          <Button type="submit" loading={add.isPending}>
            {t('patients:coverage.form.save')}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
