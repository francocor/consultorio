/** Polls until `check` returns a value other than undefined, or fails after `timeoutMs`. */
export async function eventually<T>(
  check: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`condition not met within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
