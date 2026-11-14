export function elapsedTime(start: string, end: string) {
  const seconds = Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000);
  const format = (value: number, unit: string) =>
    `${Number(value.toFixed(1))} ${unit}${Number(value.toFixed(1)) === 1 ? "" : "s"}`;
  if (seconds >= 86400) return format(seconds / 86400, "day");
  if (seconds >= 3600) return format(seconds / 3600, "hour");
  if (seconds >= 60) return format(seconds / 60, "minute");
  return format(seconds, "second");
}
