import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only registers its automatic cleanup when Vitest globals are enabled.
afterEach(() => {
  cleanup();
});
