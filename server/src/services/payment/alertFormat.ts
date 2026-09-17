/** "14 Sep 2026, 11:05 UTC" - unambiguous for admins in any timezone. */
export function formatDate(value: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getUTCDate()} ${months[value.getUTCMonth()]} ${value.getUTCFullYear()}, ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())} UTC`;
}
