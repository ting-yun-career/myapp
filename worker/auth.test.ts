import { afterEach, describe, expect, it, vi } from 'vitest'

import { requireAuth0Jwt } from './auth'

const issuer = 'https://tenant.example.auth0.com/'
const audience = 'https://appointments.example.com'

describe('requireAuth0Jwt', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('accepts a valid Auth0 access token', async () => {
    const { publicJwk, token } = await createToken()

    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        keys: [publicJwk],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await requireAuth0Jwt(
      new Request('https://example.com/api/appointments', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      {
        AUTH0_AUDIENCE: audience,
        AUTH0_DOMAIN: 'tenant.example.auth0.com',
      } as Env & { AUTH0_AUDIENCE?: string; AUTH0_DOMAIN?: string },
      ['post:appointment'],
    )

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `${issuer}.well-known/jwks.json`,
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('rejects a missing bearer token', async () => {
    const result = await requireAuth0Jwt(
      new Request('https://example.com/api/appointments'),
      {
        AUTH0_AUDIENCE: audience,
        AUTH0_DOMAIN: 'tenant.example.auth0.com',
      } as Env & { AUTH0_AUDIENCE?: string; AUTH0_DOMAIN?: string },
      ['post:appointment'],
    )

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.response.status).toBe(401)
      await expect(result.response.json()).resolves.toEqual({
        error: 'Missing bearer token.',
      })
    }
  })

  it('rejects a token with the wrong audience', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { token } = await createToken({
      aud: 'https://wrong.example.com',
    })

    const result = await requireAuth0Jwt(
      new Request('https://example.com/api/appointments', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      {
        AUTH0_AUDIENCE: audience,
        AUTH0_DOMAIN: 'tenant.example.auth0.com',
      } as Env & { AUTH0_AUDIENCE?: string; AUTH0_DOMAIN?: string },
      ['post:appointment'],
    )

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.response.status).toBe(401)
      await expect(result.response.json()).resolves.toEqual({
        error: 'Invalid bearer token.',
      })
    }

    consoleWarn.mockRestore()
  })

  it('rejects a token without the required appointment scope', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { publicJwk, token } = await createToken({
      scope: 'read:appointment',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          keys: [publicJwk],
        }),
      ),
    )

    const result = await requireAuth0Jwt(
      new Request('https://example.com/api/appointments', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      {
        AUTH0_AUDIENCE: audience,
        AUTH0_DOMAIN: 'tenant.example.auth0.com',
      } as Env & { AUTH0_AUDIENCE?: string; AUTH0_DOMAIN?: string },
      ['post:appointment'],
    )

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.response.status).toBe(403)
      await expect(result.response.json()).resolves.toEqual({
        error: 'Insufficient token scope.',
      })
    }

    consoleWarn.mockRestore()
  })
})

async function createToken(payloadOverrides: Record<string, unknown> = {}) {
  const kid = crypto.randomUUID()
  const keyPair = (await crypto.subtle.generateKey(
    {
      hash: 'SHA-256',
      modulusLength: 2048,
      name: 'RSASSA-PKCS1-v1_5',
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: 'RS256',
    kid,
    typ: 'JWT',
  }
  const payload = {
    aud: audience,
    exp: now + 300,
    iss: issuer,
    scope: 'post:appointment',
    sub: 'auth0|user_123',
    ...payloadOverrides,
  }
  const encodedHeader = base64UrlEncodeJson(header)
  const encodedPayload = base64UrlEncodeJson(payload)
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  )

  return {
    publicJwk: {
      ...publicJwk,
      alg: 'RS256',
      kid,
      use: 'sig',
    },
    token: `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`,
  }
}

function base64UrlEncodeJson(value: unknown) {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)))
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
