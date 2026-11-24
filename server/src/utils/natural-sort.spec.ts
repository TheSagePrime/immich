import { compareNatural } from 'src/utils/natural-sort.js';

describe('compareNatural', () => {
  it('should sort numbers by value', () => {
    expect(['Day 10', 'Day 2', 'Day 1'].toSorted(compareNatural)).toEqual(['Day 1', 'Day 2', 'Day 10']);
  });

  it('should ignore case', () => {
    expect(['beta', 'Alpha', 'alpha2', 'Gamma'].toSorted(compareNatural)).toEqual(['Alpha', 'alpha2', 'beta', 'Gamma']);
  });

  it('should order names that only differ in case consistently', () => {
    expect(compareNatural('a', 'A')).toBe(-compareNatural('A', 'a'));
    expect(compareNatural('a', 'A')).not.toBe(0);
    expect(compareNatural('a', 'a')).toBe(0);
  });
});
