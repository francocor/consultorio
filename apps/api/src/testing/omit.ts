/** Returns a copy of `source` without `key`. Lets a test drop one variable from a valid fixture. */
export function omit<T extends object, K extends keyof T>(source: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key)) as Omit<T, K>;
}
