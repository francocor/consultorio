import { REPRESENTATIVE_RELATIONS, type RepresentativeInput } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { formatCalendarDay } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { toast } from '../../../shared/ui/toaster.js';
import { patientKeys, patientsApi } from '../api/patients-api.js';

import { Section } from './Section.js';

/**
 * The adults in charge of a minor. They are an administrative contact only: they never get access
 * to the information of the patient, and the screen says so.
 */
export function RepresentativesSection({
  patientId,
  canWrite,
}: {
  patientId: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const list = useQuery({
    queryKey: patientKeys.representatives(patientId),
    queryFn: () => patientsApi(api).representatives(patientId),
  });

  const remove = useMutation({
    mutationFn: (representativeId: string) =>
      patientsApi(api).removeRepresentative(patientId, representativeId),
    onSuccess: async () => {
      toast.success(t('patients:representatives.removed'));
      await queryClient.invalidateQueries({ queryKey: patientKeys.representatives(patientId) });
    },
    onError: (error) => {
      toast.error(describeError(t, error).message);
    },
  });

  if (list.isPending) return null;
  if (list.isError) {
    return (
      <ErrorState
        error={list.error}
        onRetry={() => {
          void list.refetch();
        }}
      />
    );
  }
  const { minor, representatives } = list.data;
  // An adult with nobody loaded has nothing to show here.
  if (!minor && representatives.length === 0) return null;

  return (
    <Section
      title={t('patients:representatives.title')}
      description={t('patients:representatives.description')}
      action={
        canWrite ? (
          <Button
            variant="outline"
            onClick={() => {
              setAdding(true);
            }}
          >
            <UserPlus aria-hidden="true" />
            {t('patients:representatives.add')}
          </Button>
        ) : null
      }
    >
      {minor ? (
        <p className="mb-3 text-sm font-medium">{t('patients:representatives.minor')}</p>
      ) : null}
      {representatives.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('patients:representatives.empty')}</p>
      ) : (
        <ul className="grid gap-3">
          {representatives.map((person) => (
            <li
              key={person.id}
              className="flex items-start justify-between gap-3 rounded-md border p-3"
            >
              <div className="grid gap-0.5">
                <p className="font-medium">{person.fullName}</p>
                <p className="text-sm text-muted-foreground">
                  {t(`patients:representatives.relation.${person.relation}`)}
                </p>
                <p className="flex flex-wrap gap-x-3 text-sm">
                  {person.phone ? (
                    <span className="tabular inline-flex items-center gap-1">
                      <Phone className="size-3.5" aria-hidden="true" />
                      {person.phone}
                    </span>
                  ) : null}
                  {person.email ? <span>{person.email}</span> : null}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('patients:representatives.review', {
                    date: formatCalendarDay(person.majorityReviewOn),
                  })}
                </p>
              </div>
              {canWrite ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('patients:representatives.remove', { name: person.fullName })}
                  onClick={() => {
                    remove.mutate(person.id);
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <AddRepresentativeDialog patientId={patientId} open={adding} onOpenChange={setAdding} />
    </Section>
  );
}

const Schema = z
  .object({
    fullName: z.string().trim().min(1).max(80),
    relation: z.enum(['', ...REPRESENTATIVE_RELATIONS]),
    phone: z.string().trim().max(30),
    email: z.string().trim().max(254),
  })
  .superRefine((values, ctx) => {
    if (values.relation === '') {
      ctx.addIssue({ code: 'custom', path: ['relation'], message: 'validation.required' });
    }
    if (values.phone === '' && values.email === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['phone'],
        message: 'patients.form.error.representativeContact',
      });
    }
    if (values.email !== '' && !z.email().safeParse(values.email).success) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'validation.email' });
    }
  });
type Values = z.infer<typeof Schema>;

function AddRepresentativeDialog({
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
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { fullName: '', relation: '', phone: '', email: '' },
  });

  const add = useMutation({
    mutationFn: (values: Values) => {
      const body: RepresentativeInput = {
        fullName: values.fullName,
        relation: values.relation === '' ? 'other' : values.relation,
        ...(values.phone === '' ? {} : { phone: values.phone }),
        ...(values.email === '' ? {} : { email: values.email }),
      };
      return patientsApi(api).addRepresentative(patientId, body);
    },
    onSuccess: async () => {
      toast.success(t('patients:representatives.saved'));
      form.reset();
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: patientKeys.representatives(patientId) });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, { fullName: 'fullName' });
    },
  });

  const failed = add.isError && fieldErrorCount(add.error) === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          add.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
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
            <DialogHeader>
              <DialogTitle>{t('patients:representatives.add')}</DialogTitle>
              <DialogDescription>{t('patients:representatives.description')}</DialogDescription>
            </DialogHeader>
            {failed ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, add.error).message}</AlertDescription>
              </Alert>
            ) : null}
            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('patients:form.representativeName')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="relation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('patients:form.representativeRelation')}</FormLabel>
                  <FormControl>
                    <Select {...field}>
                      <option value="">{t('patients:form.representativeRelation.choose')}</option>
                      {REPRESENTATIVE_RELATIONS.map((relation) => (
                        <option key={relation} value={relation}>
                          {t(`patients:representatives.relation.${relation}`)}
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
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('patients:form.representativePhone')}</FormLabel>
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
                  <FormLabel>{t('patients:form.representativeEmail')}</FormLabel>
                  <FormControl>
                    <Input type="email" inputMode="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t('common:action.cancel')}
              </Button>
              <Button type="submit" loading={add.isPending}>
                {t('patients:representatives.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
