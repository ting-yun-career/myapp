import { useAuth0 } from '@auth0/auth0-react'
import { auth0Audience, auth0Scope } from '../auth-config'

const authorizationParams = {
  ...(auth0Audience ? { audience: auth0Audience } : {}),
  ...(auth0Scope ? { scope: auth0Scope } : {}),
}

function requiresInteractiveAuth(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const auth0Error = error as { error?: string }
  return (
    auth0Error.error === 'consent_required' ||
    auth0Error.error === 'interaction_required' ||
    auth0Error.error === 'login_required'
  )
}

function getAuth0ErrorMessage(error: unknown) {
  if (!error || typeof error !== 'object') return 'Auth0 could not issue an API access token.'
  const auth0Error = error as { error?: string; error_description?: string; message?: string }
  return (
    auth0Error.error_description ??
    auth0Error.message ??
    auth0Error.error ??
    'Auth0 could not issue an API access token.'
  )
}

export function useCloudflareApi() {
  const { getAccessTokenSilently, getAccessTokenWithPopup } = useAuth0()

  async function getToken() {
    try {
      return await getAccessTokenSilently({ authorizationParams })
    } catch (error) {
      if (requiresInteractiveAuth(error)) {
        const token = await getAccessTokenWithPopup({ authorizationParams })
        if (!token) throw new Error('Auth0 did not return an API access token.')
        return token
      }

      console.error('auth.token_failed', error)
      throw new Error(
        `${getAuth0ErrorMessage(error)} Check the API audience, application API access policy, and requested scopes.`,
      )
    }
  }

  async function doGet(url: string) {
    const token = await getToken()
    return fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
  }

  async function doPost(url: string, body: unknown) {
    const token = await getToken()
    return fetch(url, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
  }

  async function doDelete(url: string) {
    const token = await getToken()
    return fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      method: 'DELETE',
    })
  }

  return { doDelete, doGet, doPost }
}
