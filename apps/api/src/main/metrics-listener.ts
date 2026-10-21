import { createMetricsServer } from '../platform/metrics-server.js';

import type { MetricsConfig } from './config-metrics.js';

/** The two lines of the log a listener needs. */
interface ListenerLog {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Starts the metrics port of a process when the configuration asks for one, and returns how to stop
 * it. A port that cannot be taken (two processes of one machine told the same `METRICS_PORT`) is a
 * warning and not a reason to refuse to serve patients: the process goes on without metrics.
 */
export async function startMetricsListener(
  config: MetricsConfig | undefined,
  deps: { render: () => string | Promise<string>; log: ListenerLog },
): Promise<() => Promise<void>> {
  if (config === undefined) return () => Promise.resolve();
  const server = createMetricsServer({
    host: config.host,
    port: config.port,
    render: deps.render,
    ...(config.token === undefined ? {} : { token: config.token }),
    onError: () => {
      deps.log.warn('the metrics could not be measured');
    },
  });
  try {
    const address = await server.listen();
    deps.log.info(`metrics on ${address.host}:${String(address.port)}`);
    return () => server.close();
  } catch {
    deps.log.warn(
      `METRICS_PORT ${String(config.port)} on ${config.host} could not be opened (taken by another process?): this process goes on without metrics`,
    );
    return () => Promise.resolve();
  }
}
