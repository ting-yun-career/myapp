import Stripe from 'stripe'

type StripeEnv = {
  STRIPE_SECRET_KEY: string
}

export async function createPublicDepositIntent(env: StripeEnv): Promise<Response> {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY)

  const paymentIntent = await stripe.paymentIntents.create({
    amount: 100,
    currency: 'cad',
    metadata: { type: 'appointment_deposit' },
  })

  return Response.json({
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  })
}

export async function verifyDepositPayment(
  paymentIntentId: string,
  env: StripeEnv,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY)

  let paymentIntent: Stripe.PaymentIntent
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)
  } catch {
    return { ok: false, error: 'Invalid payment intent.' }
  }

  if (paymentIntent.status !== 'succeeded') {
    return { ok: false, error: 'Payment has not been completed.' }
  }

  if (paymentIntent.amount !== 100 || paymentIntent.currency !== 'cad') {
    return { ok: false, error: 'Payment amount is invalid.' }
  }

  return { ok: true }
}
