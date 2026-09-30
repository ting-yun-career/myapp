import { hashPrivateValue } from './encryption'

type WorkerEnv = Env & {
  DB?: D1Database
  PRIVACY_SALT_PHRASE?: string
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
      .all<{
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
      }>()

    const appointments = results.map(row => ({
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
    }))

    return Response.json({ appointments })
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

  try {
    await env.DB.prepare(
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
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run()
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
