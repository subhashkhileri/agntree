import { HarnessIconState, HarnessTreeIcons } from './types';

const STATES: HarnessIconState[] = ['default', 'running', 'closed', 'new'];

/**
 * Extension-relative paths for a harness's generated tree icons.
 * The files are produced by `npm run generate:icons`.
 */
export function harnessTreeIcons(harness: string): HarnessTreeIcons {
  const paths = (theme: 'light' | 'dark'): Record<HarnessIconState, string> =>
    Object.fromEntries(
      STATES.map((state) => [
        state,
        `resources/icons/harness/${harness}-${theme}-${state}.svg`,
      ])
    ) as Record<HarnessIconState, string>;

  return { light: paths('light'), dark: paths('dark') };
}
