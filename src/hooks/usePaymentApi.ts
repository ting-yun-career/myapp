import { apiBaseUrl } from '../auth-config'
import { useCloudflareApi } from './useCloudflareApi'

export function usePaymentApi() {
  const { doPost } = useCloudflareApi()

  async function createPaymentIntent(priceId: string) {
    const response = await doPost(`${apiBaseUrl}/payments/create-intent`, { priceId })
    const result = await response.json() as { clientSecret?: string; error?: string }
    if (!response.ok || !result.clientSecret) {
      throw new Error(result.error ?? 'Failed to create payment intent.')
    }
    return result.clientSecret
  }

  return { createPaymentIntent }
}
