import { Auth0Provider, type AppState } from '@auth0/auth0-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  auth0ClientId,
  auth0Connection,
  auth0Domain,
  auth0Audience,
  auth0Scope,
  hasAuth0Config,
} from './auth-config'

type AuthProviderProps = {
  children: ReactNode
}

// test
export function AuthProvider({ children }: AuthProviderProps) {
  const navigate = useNavigate()

  if (!hasAuth0Config) {
    return <>{children}</>
  }

  return (
    <Auth0Provider
      domain={auth0Domain}
      clientId={auth0ClientId}
      onRedirectCallback={(appState?: AppState) => {
        navigate(appState?.returnTo ?? '/dashboard', { replace: true })
      }}
      authorizationParams={{
        redirect_uri: window.location.origin,
        ...(auth0Audience ? { audience: auth0Audience } : {}),
        ...(auth0Scope ? { scope: auth0Scope } : {}),
        ...(auth0Connection ? { connection: auth0Connection } : {}),
      }}
    >
      {children}
    </Auth0Provider>
  )
}
