import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { stripePublishableKey } from '../auth-config'
import Button from '@repo/ui/Button'

const stripePromise = loadStripe(stripePublishableKey)

export default function CheckoutPage() {
  const location = useLocation()
  const clientSecret = (location.state as { clientSecret?: string })?.clientSecret

  if (!clientSecret) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-sm text-white/60">
        No payment session found.
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto flex min-h-screen max-w-lg items-center px-6 py-16">
        <section className="w-full rounded-[3px] border border-white/8 bg-white/[0.03] px-8 py-12 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
          <h1 className="text-2xl font-semibold tracking-tight">Complete your booking</h1>
          <p className="mt-2 text-sm text-white/50">
            A $1 CAD deposit is required to confirm your appointment. Your payment is secured by Stripe.
          </p>
          <div className="mt-8">
            <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'night' } }}>
              <CheckoutForm />
            </Elements>
          </div>
        </section>
      </div>
    </main>
  )
}

function CheckoutForm() {
  const stripe = useStripe()
  const elements = useElements()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!stripe || !elements) return

    setLoading(true)
    setError(null)

    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/payment/success`,
      },
    })

    if (stripeError) {
      setError(stripeError.message ?? 'Payment failed.')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={e => void handleSubmit(e)}>
      <PaymentElement />
      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      <div className="mt-6 flex gap-3">
        <Button disabled={!stripe || loading} type="submit" variant="solid">
          {loading ? 'Processing...' : 'Pay $1 deposit'}
        </Button>
        <Button onClick={() => navigate('/book')} variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  )
}
