export const getRangeSelection = <T>(items: T[], from: number, to: number): T[] => {
  if (from < 0 || to < 0) {
    return [];
  }

  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return items.slice(start, end + 1);
};
