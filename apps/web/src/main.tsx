import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createI18n } from './app/i18n.js';
import { AppProviders } from './app/providers.js';
import { createAppRouter } from './app/router.js';
import { createAppServices } from './app/services.js';
import { UpdatePrompt } from './app/UpdatePrompt.js';
import { installZodMessages } from './shared/lib/zod-i18n.js';

import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

installZodMessages();
const services = createAppServices({ isOnline: () => navigator.onLine });
const i18n = createI18n();
const router = createAppRouter({ services });

createRoot(container).render(
  <StrictMode>
    <AppProviders services={services} i18n={i18n}>
      <RouterProvider router={router} />
      <UpdatePrompt />
    </AppProviders>
  </StrictMode>,
);
