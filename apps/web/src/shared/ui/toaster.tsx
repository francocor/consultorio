import { Toaster as Sonner, toast } from 'sonner';

export { toast };

/**
 * Transient confirmations ("Cambios guardados"). Messages are announced politely and never carry
 * patient data: a toast is not a place for clinical or identifying content.
 */
export function Toaster() {
  return (
    <Sonner
      position="top-center"
      closeButton
      toastOptions={{
        classNames: {
          toast: 'rounded-lg border bg-popover text-popover-foreground shadow-md',
          description: 'text-muted-foreground',
        },
      }}
    />
  );
}
