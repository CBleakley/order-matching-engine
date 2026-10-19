import { describe, expect, it } from 'vitest';

import { RingBuffer } from '../../src/market/ring-buffer.js';

describe('RingBuffer', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });

  it('keeps items oldest first until full', () => {
    const buffer = new RingBuffer<number>(3);
    expect(buffer.size).toBe(0);
    expect(buffer.last()).toBeUndefined();
    buffer.push(1);
    buffer.push(2);
    expect(buffer.size).toBe(2);
    expect(buffer.last()).toBe(2);
    expect(buffer.toArray()).toEqual([1, 2]);
  });

  it('evicts the oldest item when full', () => {
    const buffer = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; ++i) buffer.push(i);
    expect(buffer.size).toBe(3);
    expect(buffer.toArray()).toEqual([5, 6, 7]);
    expect(buffer.last()).toBe(7);
  });

  it('returns the newest n items, oldest first', () => {
    const buffer = new RingBuffer<number>(4);
    for (let i = 1; i <= 6; ++i) buffer.push(i);
    expect(buffer.toArray(2)).toEqual([5, 6]);
    expect(buffer.toArray(10)).toEqual([3, 4, 5, 6]);
    expect(buffer.toArray(0)).toEqual([]);
    expect(buffer.toArray(-1)).toEqual([]);
  });

  it('replaces the newest item', () => {
    const buffer = new RingBuffer<number>(2);
    expect(() => {
      buffer.replaceLast(1);
    }).toThrow(RangeError);
    for (let i = 1; i <= 3; ++i) buffer.push(i);
    buffer.replaceLast(30);
    expect(buffer.toArray()).toEqual([2, 30]);
  });

  it('clears', () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
    buffer.push(4);
    expect(buffer.toArray()).toEqual([4]);
  });
});
