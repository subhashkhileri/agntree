/**
 * Shared text helpers for session titles and previews.
 */

/**
 * Collapse whitespace and truncate to ~50 characters on a word boundary.
 * Used for auto-generated chat names.
 */
export function truncateName(text: string): string {
  const cleaned = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 50) {
    return cleaned;
  }

  const truncated = cleaned.substring(0, 50);
  const lastSpace = truncated.lastIndexOf(' ');
  return `${lastSpace > 30 ? truncated.substring(0, lastSpace) : truncated}...`;
}

/** Collapse whitespace and truncate to one inline line of at most `max` chars. */
export function clampInlineText(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.replace(/\.\.\.$/, '').slice(0, max).trimEnd()}...`;
}

/**
 * Last non-empty text block of a message's content. Claude and opencode both
 * store assistant text this way; tool/thinking blocks are skipped.
 */
export function lastTextBlock(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: string; text?: string } | undefined;
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return block.text.trim();
    }
  }
  return '';
}

/** Compact counts for dense UI: 950, 18.2k, 1.4M. */
export function formatTokenCount(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 1_000_000) {
    const thousands = value / 1000;
    const rounded =
      thousands >= 10
        ? Math.round(thousands).toString()
        : thousands.toFixed(1).replace(/\.0$/, '');
    return `${rounded}k`;
  }
  const millions = value / 1_000_000;
  return `${millions.toFixed(1).replace(/\.0$/, '')}M`;
}

/** The message from an unknown thrown value, for user-facing errors. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cost label for a session: "$0.12", or "< $0.01" for trace amounts. */
export function formatCost(cost: number): string {
  return cost < 0.01 ? '< $0.01' : `$${cost.toFixed(2)}`;
}

/**
 * Relative time used by tree rows and pickers.
 *
 * `short` gives "now"/"16m"/"2h"/"3d"; the default adds " ago".
 * `absoluteAfterDays` falls back to a locale date once the gap is that large.
 */
export function formatRelativeTime(
  value: number | Date,
  options: { short?: boolean; absoluteAfterDays?: number } = {}
): string {
  const timestamp = typeof value === 'number' ? value : value.getTime();
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  const days = Math.floor(minutes / 1_440);

  if (
    options.absoluteAfterDays !== undefined &&
    days >= options.absoluteAfterDays
  ) {
    return new Date(timestamp).toLocaleDateString();
  }
  if (minutes < 1) return options.short ? 'now' : 'just now';
  if (minutes < 60) return options.short ? `${minutes}m` : `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return options.short ? `${hours}h` : `${hours}h ago`;
  return options.short ? `${days}d` : `${days}d ago`;
}

/**
 * Numbered names for forks.
 *
 * "Fix icons" forks as "Fix icons (1)", and a fork of that session becomes
 * "Fix icons (1) (1)". If the candidate already exists in the target worktree,
 * the suffix is incremented until it is unique.
 */
export function nextForkName(
  sourceName: string,
  existingNames: Iterable<string>
): string {
  const base = sourceName.trim() || 'Session';
  const taken = new Set(existingNames);

  let suffix = 1;
  let candidate = `${base} (${suffix})`;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${base} (${suffix})`;
  }
  return candidate;
}
