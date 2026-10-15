import { cn } from '../shared/lib/cn.js';

/** Tenant-neutral placeholder shell. The real AppShell, theming and routing arrive in Stage 1. */
export function App() {
  return (
    <div className={cn('flex min-h-screen flex-col bg-white text-slate-900')}>
      <header className="border-b border-slate-200 px-4 py-3">
        <p className="text-sm font-semibold">Gestión de consultorios</p>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <h1 className="text-2xl font-semibold">Aplicación en preparación</h1>
        <p className="text-slate-600">Estamos configurando todo para que puedas empezar.</p>
      </main>
    </div>
  );
}
