import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/progress.ts';

describe('formatDuration', () => {
  it('scales units', () => {
    expect(formatDuration(8_400)).toBe('8s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3 * 3_600_000 + 7 * 60_000)).toBe('3h 07m');
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(formatDuration(-5)).toBe('0s');
  });
});
