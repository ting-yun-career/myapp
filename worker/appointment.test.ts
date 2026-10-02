import { describe, expect, it, vi } from 'vitest'

import { createAppointment, getAppointments } from './appointment'

describe('createAppointment', () => {
  it('stores a realistic appointment request and returns the saved record', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = vi.fn().mockResolvedValue(undefined)
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })

    const request = new Request('https://example.com/api/appointments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        additionalInfo: 'Please call if the lobby door is locked.',
        email: 'alex@example.com',
        endAt: '2026-05-14T17:45:00.000Z',
        meetingLinkOrPhone: 'https://meet.example.com/alex-intake',
        name: 'Alex Chen',
        startAt: '2026-05-14T17:00:00.000Z',
        timezone: 'America/Vancouver',
      }),
    })

    const response = await createAppointment(request, {
      DB: { prepare } as unknown as D1Database,
      PRIVACY_SALT_PHRASE: 'replace-with-your-secret-salt-phrase',
    } as unknown as Env & { DB?: D1Database; PRIVACY_SALT_PHRASE?: string })

    expect(response.status).toBe(200)
    expect(prepare).toHaveBeenCalledOnce()
    expect(bind).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()

    const bindArgs = bind.mock.calls[0]

    expect(bindArgs).toHaveLength(11)
    expect(bindArgs[10]).toBeNull() // no deposit: a staff booking
    expect(bindArgs[1]).toBe('confirmed')
    expect(bindArgs[2]).toBe('2026-05-14T17:00:00.000Z')
    expect(bindArgs[3]).toBe('2026-05-14T17:45:00.000Z')
    expect(bindArgs[4]).toBe('America/Vancouver')
    expect(bindArgs[5]).toBe('Alex Chen')
    expect(bindArgs[6]).toBe('alex@example.com')
    expect(bindArgs[7]).toBe('https://meet.example.com/alex-intake')
    expect(bindArgs[8]).toBe('Please call if the lobby door is locked.')
    expect(typeof bindArgs[0]).toBe('string')
    expect(typeof bindArgs[9]).toBe('string')

    expect(consoleLog).toHaveBeenCalledWith(
      'appointments.saved',
      expect.objectContaining({
        appointment: expect.objectContaining({
          id: bindArgs[0],
          protectedDetails: {
            emailHash: expect.any(String),
            nameHash: expect.any(String),
          },
        }),
      }),
    )

    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(
      'alex@example.com',
    )
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('Alex Chen')
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(
      'https://meet.example.com/alex-intake',
    )

    await expect(response.json()).resolves.toEqual({
      appointment: {
        createdAt: bindArgs[9],
        email: 'alex@example.com',
        endAt: '2026-05-14T17:45:00.000Z',
        id: bindArgs[0],
        meetingLinkOrPhone: 'https://meet.example.com/alex-intake',
        name: 'Alex Chen',
        notes: 'Please call if the lobby door is locked.',
        startAt: '2026-05-14T17:00:00.000Z',
        status: 'confirmed',
        timezone: 'America/Vancouver',
      },
    })

    consoleLog.mockRestore()
  })

  describe('one deposit, one appointment', () => {
    const body = {
      email: 'alex@example.com',
      endAt: '2026-05-14T17:45:00.000Z',
      meetingLinkOrPhone: 'https://meet.example.com/alex-intake',
      name: 'Alex Chen',
      paymentIntentId: 'pi_123',
      startAt: '2026-05-14T17:00:00.000Z',
      timezone: 'America/Vancouver',
    }
    const request = () =>
      new Request('https://example.com/api/public/appointments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const env = (prepare: unknown) =>
      ({ DB: { prepare } as unknown as D1Database, PRIVACY_SALT_PHRASE: 'salt' }) as unknown as Env & { DB?: D1Database; PRIVACY_SALT_PHRASE?: string }
    const existingRow = {
      id: 'existing-1',
      status: 'confirmed',
      start_at_utc: '2026-05-14T17:00:00.000Z',
      end_at_utc: '2026-05-14T17:45:00.000Z',
      timezone: 'America/Vancouver',
      name: 'Alex Chen',
      email: 'alex@example.com',
      meeting_contact: 'https://meet.example.com/alex-intake',
      notes: '',
      created_at: '2026-05-14T10:00:00.000Z',
    }

    it('stores the payment intent id with the appointment, and skips an insert that would repeat one', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
      const bind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) })
      const prepare = vi.fn().mockReturnValue({ bind })

      const response = await createAppointment(request(), env(prepare))

      expect(response.status).toBe(200)
      expect(bind.mock.calls[0][10]).toBe('pi_123')
      expect(prepare.mock.calls[0][0]).toMatch(/ON CONFLICT\(payment_intent_id\).*DO NOTHING/s)
      expect(consoleLog).toHaveBeenCalledWith('appointments.saved', expect.anything())
      consoleLog.mockRestore()
    })

    it('answers a repeat of the same deposit with the appointment it already booked, creating nothing new', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
      const insertBind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }) })
      const selectBind = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [existingRow] }) })
      const prepare = vi.fn().mockReturnValueOnce({ bind: insertBind }).mockReturnValueOnce({ bind: selectBind })

      const response = await createAppointment(request(), env(prepare))

      expect(response.status).toBe(200)
      expect(selectBind).toHaveBeenCalledWith('pi_123')
      const { appointment } = (await response.json()) as { appointment: { id: string; name: string } }
      expect(appointment.id).toBe('existing-1')
      expect(appointment.name).toBe('Alex Chen')
      expect(consoleLog).toHaveBeenCalledWith('appointments.duplicate_deposit', { id: 'existing-1' })
      expect(consoleLog).not.toHaveBeenCalledWith('appointments.saved', expect.anything())
      consoleLog.mockRestore()
    })

    it('answers with a fixed message when the existing appointment cannot be looked up', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const insertBind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }) })
      const selectBind = vi.fn().mockReturnValue({ all: vi.fn().mockRejectedValue(new Error('D1_ERROR secret-internal-detail')) })
      const prepare = vi.fn().mockReturnValueOnce({ bind: insertBind }).mockReturnValueOnce({ bind: selectBind })

      const response = await createAppointment(request(), env(prepare))

      expect(response.status).toBe(500)
      const text = await response.text()
      expect(text).toContain('Failed to confirm the appointment.')
      expect(text).not.toContain('secret-internal-detail')
      consoleError.mockRestore()
    })
  })
})

describe('getAppointments', () => {
  const mockRows = [
    {
      id: 'abc-123',
      status: 'confirmed',
      start_at_utc: '2026-05-14T17:00:00.000Z',
      end_at_utc: '2026-05-14T17:45:00.000Z',
      timezone: 'America/Vancouver',
      name: 'Alex Chen',
      email: 'alex@example.com',
      meeting_contact: 'https://meet.example.com/alex-intake',
      notes: 'Please call if the lobby door is locked.',
      created_at: '2026-05-14T10:00:00.000Z',
    },
  ]

  it('returns all appointments when no filters are provided', async () => {
    const all = vi.fn().mockResolvedValue({ results: mockRows })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })

    const request = new Request('https://example.com/api/appointments')
    const response = await getAppointments(request, {
      DB: { prepare } as unknown as D1Database,
    } as unknown as Env & { DB?: D1Database })

    expect(response.status).toBe(200)
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM appointments'),
    )
    expect(bind).toHaveBeenCalledWith()

    await expect(response.json()).resolves.toEqual({
      appointments: [
        {
          createdAt: '2026-05-14T10:00:00.000Z',
          email: 'alex@example.com',
          endAt: '2026-05-14T17:45:00.000Z',
          id: 'abc-123',
          meetingLinkOrPhone: 'https://meet.example.com/alex-intake',
          name: 'Alex Chen',
          notes: 'Please call if the lobby door is locked.',
          startAt: '2026-05-14T17:00:00.000Z',
          status: 'confirmed',
          timezone: 'America/Vancouver',
        },
      ],
    })
  })

  it('filters by from and to when both are provided', async () => {
    const all = vi.fn().mockResolvedValue({ results: mockRows })
    const bind = vi.fn().mockReturnValue({ all })
    const prepare = vi.fn().mockReturnValue({ bind })

    const request = new Request(
      'https://example.com/api/appointments?from=2026-05-14T00:00:00.000Z&to=2026-05-14T23:59:59.000Z',
    )
    const response = await getAppointments(request, {
      DB: { prepare } as unknown as D1Database,
    } as unknown as Env & { DB?: D1Database })

    expect(response.status).toBe(200)
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining('start_at_utc >= ?'),
    )
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining('end_at_utc <= ?'),
    )
    expect(bind).toHaveBeenCalledWith(
      '2026-05-14T00:00:00.000Z',
      '2026-05-14T23:59:59.000Z',
    )
  })

  it('returns 400 for an invalid from date', async () => {
    const request = new Request(
      'https://example.com/api/appointments?from=not-a-date',
    )
    const response = await getAppointments(request, {
      DB: {} as unknown as D1Database,
    } as unknown as Env & { DB?: D1Database })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid "from" date parameter.',
    })
  })

  it('returns 500 when DB binding is missing', async () => {
    const request = new Request('https://example.com/api/appointments')
    const response = await getAppointments(request, {} as unknown as Env & {
      DB?: D1Database
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Database binding is missing.',
    })
  })
})
