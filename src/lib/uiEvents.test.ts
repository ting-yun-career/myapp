import { describe, expect, it, vi } from 'vitest'
import { createUiEventBus, isUiEvent, type UiEvent } from './uiEvents'

const proposed: UiEvent = { type: 'slot.proposed', payload: { date: '2026-10-06', startTime: '10:00', endTime: '11:00' } }
const deleted: UiEvent = { type: 'appointment.deleted', payload: { id: 'appt-1' } }
const created = {
  type: 'appointment.created' as const,
  payload: { id: 'appt-2', createdAt: '2026-10-02T00:00:00.000Z', email: 'a@a.com', endAt: '2026-10-06T17:00:00.000Z', meetingLinkOrPhone: '12345678', name: 'Tim', notes: '', startAt: '2026-10-06T16:00:00.000Z', status: 'confirmed', timezone: 'America/Toronto' },
}

describe('createUiEventBus', () => {
  it('delivers an event to every subscriber of its type, and only to those', () => {
    const bus = createUiEventBus()
    const first = vi.fn()
    const second = vi.fn()
    const other = vi.fn()
    bus.subscribe('slot.proposed', first)
    bus.subscribe('slot.proposed', second)
    bus.subscribe('appointment.deleted', other)

    bus.publish(proposed)

    expect(first).toHaveBeenCalledWith(proposed)
    expect(second).toHaveBeenCalledWith(proposed)
    expect(other).not.toHaveBeenCalled()
  })

  it('stops delivering after the returned unsubscribe is called', () => {
    const bus = createUiEventBus()
    const handler = vi.fn()
    const unsubscribe = bus.subscribe('appointment.deleted', handler)

    bus.publish(deleted)
    unsubscribe()
    bus.publish(deleted)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does nothing when nobody is subscribed', () => {
    expect(() => createUiEventBus().publish(deleted)).not.toThrow()
  })

  it('keeps delivering to the other subscribers when one throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = createUiEventBus()
    const after = vi.fn()
    bus.subscribe('appointment.deleted', () => {
      throw new Error('boom')
    })
    bus.subscribe('appointment.deleted', after)

    bus.publish(deleted)

    expect(after).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  it('lets a handler unsubscribe itself without skipping the next one', () => {
    const bus = createUiEventBus()
    const next = vi.fn()
    const unsubscribe = bus.subscribe('appointment.deleted', () => unsubscribe())
    bus.subscribe('appointment.deleted', next)

    bus.publish(deleted)

    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('isUiEvent', () => {
  it('accepts the events this version understands', () => {
    expect(isUiEvent(proposed)).toBe(true)
    expect(isUiEvent(deleted)).toBe(true)
    expect(isUiEvent(created)).toBe(true)
  })

  it('rejects an unknown type, so a newer worker cannot reach code without a widget for it', () => {
    expect(isUiEvent({ type: 'from-the-future', payload: {} })).toBe(false)
  })

  it.each([
    ['null', null],
    ['a string', 'slot.proposed'],
    ['no payload', { type: 'slot.proposed' }],
    ['a slot without times', { type: 'slot.proposed', payload: { date: '2026-10-06' } }],
    ['a deletion without an id', { type: 'appointment.deleted', payload: {} }],
    ['a deletion with a non-string id', { type: 'appointment.deleted', payload: { id: 7 } }],
    ['a booking with no start time', { type: 'appointment.created', payload: { ...created.payload, startAt: undefined } }],
    ['a booking whose id is not text', { type: 'appointment.created', payload: { ...created.payload, id: 7 } }],
  ])('rejects %s', (_name, value) => {
    expect(isUiEvent(value)).toBe(false)
  })
})
