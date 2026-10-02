import { hashPrivateValue } from './encryption'

type WorkerEnv = Env & {
  DB?: D1Database
  PRIVACY_SALT_PHRASE?: string
}

type AppointmentRow = {
  id: string
  status: string
  start_at_utc: string
  end_at_utc: string
  timezone: string
  name: string
  email: string
  meeting_contact: string
  notes: string
  created_at: string
}

function appointmentFromRow(row: AppointmentRow) {
  return {
    createdAt: row.created_at,
    email: row.email,
    endAt: row.end_at_utc,
    id: row.id,
    meetingLinkOrPhone: row.meeting_contact,
    name: row.name,
    notes: row.notes,
    startAt: row.start_at_utc,
    status: row.status,
    timezone: row.timezone,
  }
}

export async function getAppointments(request: Request, env: WorkerEnv) {
  if (!env.DB) {
    return Response.json(
      { error: 'Database binding is missing.' },
      { status: 500 },
    )
  }

  const url = new URL(request.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')

  if (from && Number.isNaN(new Date(from).getTime())) {
    return Response.json(
      { error: 'Invalid "from" date parameter.' },
      { status: 400 },
    )
  }

  if (to && Number.isNaN(new Date(to).getTime())) {
    return Response.json(
      { error: 'Invalid "to" date parameter.' },
      { status: 400 },
    )
  }

  try {
    let query: string
    let bindings: string[]

    if (from && to) {
      query = `SELECT * FROM appointments WHERE start_at_utc >= ? AND end_at_utc <= ? ORDER BY start_at_utc ASC`
      bindings = [new Date(from).toISOString(), new Date(to).toISOString()]
    } else if (from) {
      query = `SELECT * FROM appointments WHERE start_at_utc >= ? ORDER BY start_at_utc ASC`
      bindings = [new Date(from).toISOString()]
    } else if (to) {
      query = `SELECT * FROM appointments WHERE end_at_utc <= ? ORDER BY start_at_utc ASC`
      bindings = [new Date(to).toISOString()]
    } else {
      query = `SELECT * FROM appointments ORDER BY start_at_utc ASC`
      bindings = []
    }

    const { results } = await env.DB.prepare(query)
      .bind(...bindings)
      .all<AppointmentRow>()

    return Response.json({ appointments: results.map(appointmentFromRow) })
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to fetch appointments.'

    console.error('appointments.fetch_failed', {
      errorMessage,
      from,
      to,
    })

    return Response.json({ error: errorMessage }, { status: 500 })
  }
}

export async function deleteAppointment(
  id: string,
  env: WorkerEnv,
) {
  if (!env.DB) {
    return Response.json(
      { error: 'Database binding is missing.' },
      { status: 500 },
    )
  }

  if (!id) {
    return Response.json({ error: 'Missing appointment id.' }, { status: 400 })
  }

  try {
    const result = await env.DB.prepare(
      `DELETE FROM appointments WHERE id = ?`,
    )
      .bind(id)
      .run()

    if (!result.meta.changes) {
      return Response.json({ error: 'Appointment not found.' }, { status: 404 })
    }

    console.log('appointments.deleted', { id })

    return Response.json({ deleted: true })
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to delete appointment.'

    console.error('appointments.delete_failed', { errorMessage, id })

    return Response.json({ error: errorMessage }, { status: 500 })
  }
}

export async function createAppointment(request: Request, env: WorkerEnv) {
  if (!env.DB) {
    return Response.json(
      { error: 'Database binding is missing.' },
      { status: 500 },
    )
  }

  const privacySaltPhrase = env.PRIVACY_SALT_PHRASE?.trim()

  if (!privacySaltPhrase) {
    console.error('appointments.privacy_salt_missing', {
      method: request.method,
      path: new URL(request.url).pathname,
    })
    return Response.json(
      { error: 'Privacy salt phrase is missing.' },
      { status: 500 },
    )
  }

  let payload: {
    additionalInfo?: string
    email?: string
    endAt?: string
    meetingLinkOrPhone?: string
    name?: string
    paymentIntentId?: string
    startAt?: string
    timezone?: string
  }
  try {
    payload = (await request.json()) as typeof payload
  } catch (error) {
    console.error('appointments.invalid_json_body', {
      error: error instanceof Error ? error.message : String(error),
      method: request.method,
      path: new URL(request.url).pathname,
    })
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const appointment = {
    createdAt: new Date().toISOString(),
    email: payload.email?.trim() ?? '',
    endAt: payload.endAt ?? '',
    id: crypto.randomUUID(),
    meetingContact: payload.meetingLinkOrPhone?.trim() ?? '',
    name: payload.name?.trim() ?? '',
    notes: payload.additionalInfo?.trim() ?? '',
    // Set for public bookings, which index.ts has already verified with Stripe; null for staff ones.
    paymentIntentId: typeof payload.paymentIntentId === 'string' && payload.paymentIntentId.trim() ? payload.paymentIntentId.trim() : null,
    startAt: payload.startAt ?? '',
    status: 'confirmed',
    timezone: payload.timezone?.trim() ?? 'America/Vancouver',
  }

  if (
    !appointment.name ||
    !appointment.email ||
    !appointment.meetingContact ||
    !appointment.startAt ||
    !appointment.endAt
  ) {
    return Response.json(
      { error: 'Missing required appointment fields.' },
      { status: 400 },
    )
  }

  const startAt = new Date(appointment.startAt)
  const endAt = new Date(appointment.endAt)

  if (
    Number.isNaN(startAt.getTime()) ||
    Number.isNaN(endAt.getTime()) ||
    endAt <= startAt
  ) {
    return Response.json(
      { error: 'Appointment time range is invalid.' },
      { status: 400 },
    )
  }

  let inserted = false

  try {
    const result = await env.DB.prepare(
      `INSERT INTO appointments (
        id,
        status,
        start_at_utc,
        end_at_utc,
        timezone,
        name,
        email,
        meeting_contact,
        notes,
        created_at,
        payment_intent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(payment_intent_id) WHERE payment_intent_id IS NOT NULL DO NOTHING`,
    )
      .bind(
        appointment.id,
        appointment.status,
        startAt.toISOString(),
        endAt.toISOString(),
        appointment.timezone,
        appointment.name,
        appointment.email,
        appointment.meetingContact,
        appointment.notes,
        appointment.createdAt,
        appointment.paymentIntentId,
      )
      .run()
    // 0 changes: this deposit already booked an appointment (the unique index skipped the insert).
    inserted = (result?.meta?.changes ?? 0) > 0
  } catch (error) {
    const causeMessage =
      error &&
      typeof error === 'object' &&
      'cause' in error &&
      error.cause &&
      typeof error.cause === 'object' &&
      'message' in error.cause &&
      typeof error.cause.message === 'string'
        ? error.cause.message
        : ''

    const errorMessage =
      error instanceof Error ? error.message : 'Failed to insert appointment.'

    console.error('appointments.insert_failed', {
      causeMessage,
      endAt: appointment.endAt,
      errorMessage,
      hasNotes: Boolean(appointment.notes),
      id: appointment.id,
      meetingContactLength: appointment.meetingContact.length,
      startAt: appointment.startAt,
      timezone: appointment.timezone,
    })

    return Response.json(
      {
        error: causeMessage ? `${errorMessage}: ${causeMessage}` : errorMessage,
      },
      { status: 500 },
    )
  }

  if (!inserted && appointment.paymentIntentId) {
    // This deposit already booked an appointment (a repeated or double-submitted request), so answer
    // with that one instead of creating a second.
    try {
      const { results } = await env.DB.prepare(`SELECT * FROM appointments WHERE payment_intent_id = ?`)
        .bind(appointment.paymentIntentId)
        .all<AppointmentRow>()
      if (results[0]) {
        console.log('appointments.duplicate_deposit', { id: results[0].id })
        return Response.json({ appointment: appointmentFromRow(results[0]) })
      }
    } catch (error) {
      console.error('appointments.duplicate_lookup_failed', {
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
    return Response.json({ error: 'Failed to confirm the appointment.' }, { status: 500 })
  }

  console.log('appointments.saved', {
    appointment: {
      createdAt: appointment.createdAt,
      endAt: endAt.toISOString(),
      id: appointment.id,
      startAt: startAt.toISOString(),
      status: appointment.status,
      timezone: appointment.timezone,
      protectedDetails: {
        nameHash: await hashPrivateValue(appointment.name, privacySaltPhrase),
        emailHash: await hashPrivateValue(appointment.email, privacySaltPhrase),
      },
    },
    request: {
      method: request.method,
      path: new URL(request.url).pathname,
    },
  })

  return Response.json({
    appointment: {
      createdAt: appointment.createdAt,
      email: appointment.email,
      endAt: endAt.toISOString(),
      id: appointment.id,
      meetingLinkOrPhone: appointment.meetingContact,
      name: appointment.name,
      notes: appointment.notes,
      startAt: startAt.toISOString(),
      status: appointment.status,
      timezone: appointment.timezone,
    },
  })
}
