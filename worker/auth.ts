import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

type AuthEnv = Env & {
  AUTH0_AUDIENCE?: string
  AUTH0_DOMAIN?: string
}

type JwtPayload = JWTPayload & {
  scope?: string
}

export type AuthResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; response: Response }

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
const jwksCacheTtlMs = 5 * 60 * 1000
const clockToleranceSeconds = 60

export async function requireAuth0Jwt(
  request: Request,
  env: AuthEnv,
  requiredScopes: string[] = [],
): Promise<AuthResult> {
  const audience = env.AUTH0_AUDIENCE?.trim()
  const issuer = getIssuer(env.AUTH0_DOMAIN)

  if (!audience || !issuer) {
    console.error('auth.config_missing', {
      hasAudience: Boolean(audience),
      hasDomain: Boolean(env.AUTH0_DOMAIN?.trim()),
      path: new URL(request.url).pathname,
    })

    return {
      ok: false,
      response: Response.json(
        { error: 'Authentication is not configured.' },
        { status: 500 },
      ),
    }
  }

  const token = getBearerToken(request)

  console.log('auth.token_check', { hasToken: Boolean(token), authHeader: request.headers.get('authorization')?.slice(0, 30) })

  if (!token) {
    return unauthorized('Missing bearer token.')
  }

  console.log('auth.verifying', { audience, issuer, tokenPrefix: token.slice(0, 20) })

  try {
    const payload = await verifyJwt(token, {
      audience,
      issuer,
      requiredScopes,
    })
    return { ok: true, payload }
  } catch (error) {
    if (error instanceof MissingScopeError) {
      console.warn('auth.scope_rejected', {
        missingScopes: error.missingScopes,
        path: new URL(request.url).pathname,
      })

      return forbidden('Insufficient token scope.')
    }

    console.warn('auth.token_rejected', {
      error: error instanceof Error ? error.message : String(error),
      errorCode: (error as { code?: string }).code,
      audience,
      issuer,
      path: new URL(request.url).pathname,
    })

    return unauthorized('Invalid bearer token.')
  }
}

class MissingScopeError extends Error {
  missingScopes: string[]

  constructor(missingScopes: string[]) {
    super('JWT is missing required scopes.')
    this.missingScopes = missingScopes
  }
}

function forbidden(error: string): AuthResult {
  return {
    ok: false,
    response: Response.json({ error }, { status: 403 }),
  }
}

function unauthorized(error: string): AuthResult {
  return {
    ok: false,
    response: Response.json(
      { error },
      {
        headers: {
          'WWW-Authenticate': 'Bearer',
        },
        status: 401,
      },
    ),
  }
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get('authorization')?.trim()

  if (!authorization) {
    return ''
  }

  const [scheme, token, extra] = authorization.split(/\s+/)

  if (scheme?.toLowerCase() !== 'bearer' || !token || extra) {
    return ''
  }

  return token
}

function getIssuer(domain?: string) {
  const trimmedDomain = domain?.trim().replace(/\/+$/, '')

  if (!trimmedDomain) {
    return ''
  }

  if (trimmedDomain.startsWith('https://')) {
    return `${trimmedDomain}/`
  }

  return `https://${trimmedDomain}/`
}

async function verifyJwt(
  token: string,
  expected: { audience: string; issuer: string; requiredScopes: string[] },
) {
  const { payload } = await jwtVerify(token, getJwks(expected.issuer), {
    algorithms: ['RS256'],
    audience: expected.audience,
    clockTolerance: clockToleranceSeconds,
    issuer: expected.issuer,
  })

  validateScopes(payload, expected.requiredScopes)
  return payload
}

function validateScopes(payload: JwtPayload, requiredScopes: string[]) {
  const grantedScopes = new Set(payload.scope?.split(/\s+/).filter(Boolean))
  const missingScopes = requiredScopes.filter(
    (scope) => !grantedScopes.has(scope),
  )

  if (missingScopes.length > 0) {
    throw new MissingScopeError(missingScopes)
  }
}

function getJwks(issuer: string) {
  const cachedJwks = jwksCache.get(issuer)

  if (cachedJwks) {
    return cachedJwks
  }

  const jwks = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`), {
    cacheMaxAge: jwksCacheTtlMs,
    cooldownDuration: 0,
  })

  jwksCache.set(issuer, jwks)
  return jwks
}
