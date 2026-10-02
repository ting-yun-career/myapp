import { useAuth0 } from '@auth0/auth0-react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import AuthenticatedBookingCalendar from './components/web/BookingCalendar/AuthenticatedBookingCalendar'
import ChatWidget from './components/web/Chatbot/ChatWidget'
import UiEventBusProvider from './lib/UiEventBusProvider'
import Icon from './components/web/Icon'
import HomeLink from './components/HomeLink'
import MenuDropdown from './components/MenuDropdown'
import Button from '@repo/ui/Button'
import BottomNav from '@repo/ui/BottomNav'
import type { BottomNavItem } from '@repo/ui/BottomNav'
import { hasAuth0Config } from './auth-config'
import CheckoutPage from './pages/Checkout'
import PaymentSuccessPage from './pages/PaymentSuccess'
import BookingPage from './pages/BookingPage'
import AppointmentsPage from './pages/AppointmentsPage'
import StatsPage from './pages/StatsPage'

const NAV_ITEMS: BottomNavItem[] = [
  { id: '/dashboard', icon: <Icon size={14} type="calendar" />, label: 'Calendar' },
  { id: '/appointments', icon: <Icon size={14} type="appointments" />, label: 'Appointments' },
  { id: '/stats', icon: <Icon size={14} type="stats" />, label: 'Stats' },
]

function App() {
  return (
    <UiEventBusProvider>
      <Routes>
        <Route element={<LandingPage />} path="/" />
        <Route
          element={
            <RequireAuth>
              <AuthenticatedShell>
                <DashboardPage />
              </AuthenticatedShell>
            </RequireAuth>
          }
          path="/dashboard"
        />
        <Route
          element={
            <RequireAuth>
              <AuthenticatedShell>
                <AppointmentsPage />
              </AuthenticatedShell>
            </RequireAuth>
          }
          path="/appointments"
        />
        <Route
          element={
            <RequireAuth>
              <AuthenticatedShell>
                <StatsPage />
              </AuthenticatedShell>
            </RequireAuth>
          }
          path="/stats"
        />
        <Route
          element={
            <PublicShell>
              <BookingPage />
            </PublicShell>
          }
          path="/book"
        />
        <Route
          element={
            <PublicShell>
              <CheckoutPage />
            </PublicShell>
          }
          path="/checkout"
        />
        <Route
          element={
            <PublicShell>
              <PaymentSuccessPage />
            </PublicShell>
          }
          path="/payment/success"
        />
        <Route element={<Navigate replace to="/" />} path="*" />
      </Routes>
      <ChatWidget />
    </UiEventBusProvider>
  )
}

function AuthenticatedShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { logout } = useAuth0()

  const menuItems = [
    {
      label: 'Log out',
      onClick: () => {
        if (!hasAuth0Config) return
        logout({ logoutParams: { returnTo: window.location.origin } })
      },
    },
  ]

  return (
    <>
      <div className="fixed left-4 top-4 z-20 sm:left-6 sm:top-6">
        <MenuDropdown items={menuItems} />
      </div>
      {children}
      <BottomNav
        activeId={location.pathname}
        items={NAV_ITEMS}
        onItemClick={(item) => navigate(item.id)}
      />
    </>
  )
}

function PublicShell({ children }: { children: ReactNode }) {
  return (
    <>
      <HomeLink />
      {children}
    </>
  )
}

function LandingPage() {
  const navigate = useNavigate()
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0()

  useEffect(() => {
    if (hasAuth0Config && !isLoading && isAuthenticated) {
      navigate('/dashboard', { replace: true })
    }
  }, [isAuthenticated, isLoading, navigate])

  const handleLogin = async () => {
    if (!hasAuth0Config) {
      navigate('/dashboard')
      return
    }

    await loginWithRedirect({
      appState: {
        returnTo: '/dashboard',
      },
    })
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <div className="mx-auto flex min-h-screen max-w-5xl items-center px-6 py-16">
        <section className="w-full rounded-[3px] border border-white/8 bg-white/[0.03] px-8 py-12 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:px-12">
          <p className="text-sm uppercase tracking-[0.28em] text-white/45">
            Appointment Platform
          </p>
          <h1 className="mt-4 max-w-2xl text-5xl font-semibold tracking-tight text-white">
            Book and manage appointments from one dashboard.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-white/68">
            Sign in to access the booking dashboard and continue with the
            calendar workflow.
          </p>
          <div className="mt-10">
            <Button onClick={() => void handleLogin()} variant="solid">
              Login
            </Button>
          </div>
        </section>
      </div>
    </main>
  )
}

function DashboardPage() {
  return (
    <div className="relative min-h-screen">
      <AuthenticatedBookingCalendar />
    </div>
  )
}

function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0()

  useEffect(() => {
    if (hasAuth0Config && !isLoading && !isAuthenticated) {
      void loginWithRedirect({
        appState: {
          returnTo: location.pathname,
        },
      })
    }
  }, [isAuthenticated, isLoading, location.pathname, loginWithRedirect])

  if (!hasAuth0Config) {
    return children
  }

  if (isLoading || !isAuthenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-sm text-white/60">
        Loading dashboard...
      </main>
    )
  }

  return children
}

export default App
