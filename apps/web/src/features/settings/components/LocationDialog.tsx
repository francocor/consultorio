import type { LocationDto } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { locationsApi, LOCATIONS_QUERY_KEY } from '../../../shared/api/locations-api.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { toast } from '../../../shared/ui/toaster.js';

import { describeTimeZone, TIME_ZONES } from './location-form.js';

const Schema = z.object({
  name: z.string().trim().min(1).max(120),
  timeZone: z.string().min(1),
});
type Values = z.infer<typeof Schema>;

const DEFAULT_ZONE = TIME_ZONES[0];

/** Creates a location, or edits an existing one when `location` is given. */
export function LocationDialog({
  open,
  onOpenChange,
  location,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: LocationDto | null;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    values: { name: location?.name ?? '', timeZone: location?.timeZone ?? DEFAULT_ZONE },
  });
  // A zone the list does not know (set by an operator) stays selectable.
  const zones =
    location && !TIME_ZONES.some((zone) => zone === location.timeZone)
      ? [location.timeZone, ...TIME_ZONES]
      : TIME_ZONES;

  const save = useMutation({
    mutationFn: (values: Values) =>
      location ? locationsApi(api).update(location.id, values) : locationsApi(api).create(values),
    onSuccess: async () => {
      toast.success(location ? t('settings:locations.updated') : t('settings:locations.created'));
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: LOCATIONS_QUERY_KEY });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) save.reset();
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
                save.mutate(values);
              })(event);
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {location
                  ? t('settings:locations.form.editTitle')
                  : t('settings:locations.form.createTitle')}
              </DialogTitle>
              <DialogDescription>{t('settings:locations.form.description')}</DialogDescription>
            </DialogHeader>

            {save.isError && fieldErrorCount(save.error) === 0 ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
              </Alert>
            ) : null}

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('settings:locations.form.name')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="timeZone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('settings:locations.form.timeZone')}</FormLabel>
                  <FormControl>
                    <Select {...field}>
                      {zones.map((zone) => (
                        <option key={zone} value={zone}>
                          {describeTimeZone(zone)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormDescription>{t('settings:locations.form.timeZoneHelp')}</FormDescription>
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
              <Button type="submit" loading={save.isPending}>
                {location ? t('settings:locations.form.save') : t('settings:locations.form.create')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
