import { describe, expect, it } from 'vitest'
import { dayKey, dayLabel } from './dayLabel'

// 2026-10-02 06:10 in Vancouver (PDT, UTC-7).
const NOW = new Date('2026-10-02T13:10:00.000Z')
const VANCOUVER = 'America/Vancouver'

describe('dayLabel', () => {
  it('uses the visitor-local day, not the UTC day', () => {
    // 2026-10-02T03:00Z is still Oct 1 evening in Vancouver, but Oct 2 in UTC.
    expect(dayLabel('2026-10-02T03:00:00.000Z', NOW, VANCOUVER)).toBe('Yesterday')
    expect(dayLabel('2026-10-02T03:00:00.000Z', NOW, 'UTC')).toBe('Today')
  })

  it('labels today, yesterday and a count of days', () => {
    expect(dayLabel('2026-10-02T07:30:00.000Z', NOW, VANCOUVER)).toBe('Today') // 00:30 local
    expect(dayLabel('2026-10-01T20:00:00.000Z', NOW, VANCOUVER)).toBe('Yesterday')
    expect(dayLabel('2026-09-30T20:00:00.000Z', NOW, VANCOUVER)).toBe('2 days ago')
    expect(dayLabel('2026-09-29T20:00:00.000Z', NOW, VANCOUVER)).toBe('3 days ago')
    expect(dayLabel('2026-09-26T20:00:00.000Z', NOW, VANCOUVER)).toBe('6 days ago')
  })

  it('counts calendar days: 11pm last night is yesterday at 7am', () => {
    const lateLastNight = '2026-10-02T06:00:00.000Z' // 23:00 Oct 1 local
    expect(dayLabel(lateLastNight, new Date('2026-10-02T14:00:00.000Z'), VANCOUVER)).toBe('Yesterday')
  })

  it('does not shift a label across a DST change', () => {
    // US clocks go back on 2026-11-01, so that day is 25 hours long.
    const now = new Date('2026-11-02T15:00:00.000Z')
    expect(dayLabel('2026-11-01T07:30:00.000Z', now, VANCOUVER)).toBe('Yesterday') // 00:30 PDT Nov 1
    expect(dayLabel('2026-11-01T00:30:00.000Z', now, VANCOUVER)).toBe('2 days ago') // 17:30 PDT Oct 31
  })

  it('falls back to a date after a week, with the year only when it differs', () => {
    expect(dayLabel('2026-09-20T20:00:00.000Z', NOW, VANCOUVER)).toBe('Sun, Sep 20')
    expect(dayLabel('2025-12-24T20:00:00.000Z', NOW, VANCOUVER)).toBe('Wed, Dec 24, 2025')
  })

  it('returns null for an invalid time', () => {
    expect(dayLabel('not a date', NOW, VANCOUVER)).toBeNull()
  })
})

describe('dayKey', () => {
  it('gives the same key for messages on the same local day', () => {
    expect(dayKey('2026-10-02T07:30:00.000Z', VANCOUVER)).toBe('2026-10-02')
    expect(dayKey('2026-10-03T06:59:00.000Z', VANCOUVER)).toBe('2026-10-02')
    expect(dayKey('2026-10-03T07:00:00.000Z', VANCOUVER)).toBe('2026-10-03')
  })

  it('returns null for an invalid time', () => {
    expect(dayKey('nope', VANCOUVER)).toBeNull()
  })
})
