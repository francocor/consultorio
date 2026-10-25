import { waitForShutdown } from '../../src/main/shutdown.js';

// A process that behaves like `main.js api` does while it runs: it waits to be told to stop.
process.send?.({ type: 'up' });
await waitForShutdown();
process.stdout.write('stopped\n');
