export const auth0Domain = import.meta.env.VITE_AUTH0_DOMAIN
export const auth0ClientId = import.meta.env.VITE_AUTH0_CLIENT_ID
export const auth0Connection = import.meta.env.VITE_AUTH0_CONNECTION
export const auth0Audience = import.meta.env.VITE_AUTH0_AUDIENCE
export const auth0Scope = import.meta.env.VITE_AUTH0_SCOPE
export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL

export const stripePublishableKey =
  import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? ''

export const hasAuth0Config = Boolean(auth0Domain && auth0ClientId)
