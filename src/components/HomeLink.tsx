import { Link } from 'react-router-dom'
import Icon from './web/Icon'

export default function HomeLink() {
  return (
    <Link
      className="fixed left-4 top-4 z-20 flex h-9 items-center gap-1 rounded-md bg-white/20 py-0 pl-2 pr-3 text-sm text-white/70 transition hover:bg-white/30 hover:text-white sm:left-6 sm:top-6"
      to="/"
    >
      <Icon size={16} type="chevron-left" />
      Home
    </Link>
  )
}
