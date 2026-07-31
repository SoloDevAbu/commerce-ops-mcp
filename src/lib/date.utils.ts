/**
 * Returns the number of hours elapsed since the given ISO-8601 timestamp.
 * Returns 0 if the value is null or undefined.
 */
export function hoursSince(isoString: string | null | undefined): number {
  if (!isoString) return 0;
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60);
}

/**
 * Returns an ISO-8601 timestamp representing `hours` hours ago from now.
 */
export function isoAfter(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}
