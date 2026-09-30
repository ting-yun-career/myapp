import {
  createAppointment,
  deleteAppointment,
  getAppointments,
} from './appointment'
import { requireAuth0Jwt } from './auth'
import { createPublicDepositIntent, verifyDepositPayment } from './stripe'
import { handleChatMessage, handleGetChatHistory } from './chat'
import { handleStats } from './stats'

type WorkerEnv = Env & {
  ANTHROPIC_API_KEY?: string
  AUTH0_AUDIENCE?: string
  AUTH0_DOMAIN?: string
  DB?: D1Database
  STRIPE_SECRET_KEY?: string
}

export default {
  async fetch(request, env) {
    const runtimeEnv = env as WorkerEnv
    const url = new URL(request.url)

    console.log('worker.fetch', {
      method: request.method,
      pathname: url.pathname,
    })

    if (url.pathname === '/api/public/appointments') {
      if (request.method === 'GET') return getAppointments(request, runtimeEnv)
      if (request.method === 'POST') {
        if (!runtimeEnv.STRIPE_SECRET_KEY) {
          return Response.json({ error: 'Payment is not configured.' }, { status: 500 })
        }
        let body: Record<string, unknown>
        try {
          body = (await request.json()) as Record<string, unknown>
        } catch {
          return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
        }
        const paymentIntentId =
          typeof body.paymentIntentId === 'string' ? body.paymentIntentId : ''
        if (!paymentIntentId) {
          return Response.json(
            { error: 'A $1 deposit payment is required to book an appointment.' },
            { status: 402 },
          )
        }
        const verification = await verifyDepositPayment(
          paymentIntentId,
          runtimeEnv as WorkerEnv & { STRIPE_SECRET_KEY: string },
        )
        if (!verification.ok) {
          return Response.json({ error: verification.error }, { status: 402 })
        }
        const verifiedRequest = new Request(request.url, {
          method: 'POST',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        })
        return createAppointment(verifiedRequest, runtimeEnv)
      }
    }

    if (
      url.pathname === '/api/public/payments/create-deposit-intent' &&
      request.method === 'POST'
    ) {
      if (!runtimeEnv.STRIPE_SECRET_KEY) {
        return Response.json({ error: 'Payment is not configured.' }, { status: 500 })
      }
      return createPublicDepositIntent(
        runtimeEnv as WorkerEnv & { STRIPE_SECRET_KEY: string },
      )
    }

    if (url.pathname === '/api/appointments' && request.method === 'GET') {
      const auth = await requireAuth0Jwt(request, runtimeEnv, [
        'get:appointment',
      ])

      if (!auth.ok) {
        return auth.response
      }

      return getAppointments(request, runtimeEnv)
    }

    if (url.pathname === '/api/appointments' && request.method === 'POST') {
      const auth = await requireAuth0Jwt(request, runtimeEnv, [
        'post:appointment',
      ])

      if (!auth.ok) {
        return auth.response
      }

      return createAppointment(request, runtimeEnv)
    }

    const deleteMatch = url.pathname.match(/^\/api\/appointments\/([^/]+)$/)
    if (deleteMatch && request.method === 'DELETE') {
      const auth = await requireAuth0Jwt(request, runtimeEnv, [
        'delete:appointment',
      ])

      if (!auth.ok) {
        return auth.response
      }

      return deleteAppointment(deleteMatch[1], runtimeEnv)
    }

    if (url.pathname === '/api/public/chat' && request.method === 'GET') {
      return handleGetChatHistory(request, runtimeEnv)
    }

    if (url.pathname === '/api/public/chat' && request.method === 'POST') {
      if (!runtimeEnv.ANTHROPIC_API_KEY) {
        return Response.json({ error: 'Chat is not configured.' }, { status: 500 })
      }
      return handleChatMessage(request, runtimeEnv)
    }

    if (url.pathname.startsWith('/api/stats/') && request.method === 'GET') {
      const auth = await requireAuth0Jwt(request, runtimeEnv, ['get:stats'])

      if (!auth.ok) {
        return auth.response
      }

      return handleStats(request, runtimeEnv)
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found.' }, { status: 404 })
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
