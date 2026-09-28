/** Helper functions for texts in Polish. */

/**
 * Noun inflection after a numeral: 1 zmiana, 2 zmiany, 5 zmian, 12 zmian, 22 zmiany.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(count);
  if (n === 1) {
    return one;
  }
  const lastDigit = n % 10;
  const lastTwo = n % 100;
  return lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
}

/** "3 zmiany", "1 zmiana", "0 zmian". */
export function countLabel(count: number, one: string, few: string, many: string): string {
  return `${count} ${plural(count, one, few, many)}`;
}

const relative = new Intl.RelativeTimeFormat('pl', { numeric: 'auto' });

/** Relative time, e.g. "12 minut temu", "wczoraj", "w zeszłym tygodniu". */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) {
    return 'przed chwilą';
  }
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2629800],
    ['year', 31557600]
  ];
  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  let size = 60;
  for (const [candidate, candidateSize] of units) {
    if (abs >= candidateSize) {
      unit = candidate;
      size = candidateSize;
    }
  }
  return relative.format(Math.round(seconds / size), unit);
}
