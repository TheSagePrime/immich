const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const compareNatural = (a: string, b: string) => {
  const result = collator.compare(a, b);
  if (result !== 0) {
    return result;
  }

  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
};
