const SECONDS_THRESHOLD = 10_000_000_000;

export const toMillisecondsTimestamp = (value: number): number =>
  value < SECONDS_THRESHOLD ? value * 1000 : value;
