/** A function that runs `fn` once calls have been quiet for `ms`. */
export interface Debounced {
  (): void;
  /** Drop a pending call. */
  cancel(): void;
}

export function debounce(fn: () => void, ms: number): Debounced {
  let timer: NodeJS.Timeout | undefined;
  const debounced = (() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  }) as Debounced;
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}
