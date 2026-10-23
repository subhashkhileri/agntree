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

/** Truncate to `max` characters with a trailing ellipsis when shortened. */
export function truncateWithEllipsis(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.substring(0, max)}...`;
}
