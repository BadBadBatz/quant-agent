import Link from 'next/link';
import SystemStatus from '@/components/SystemStatus';
import BottomNav from '@/components/BottomNav';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/decisions', label: 'Decisions' },
  { href: '/trades', label: 'Trades' },
  { href: '/reports', label: 'Reports' },
  { href: '/config', label: 'Config' },
];

export default function AppLayout({ children }) {
  return (
    <>
      <header className="border-b border-[#1e1e1e] px-4 sm:px-6 h-12 flex items-center justify-between sticky top-0 bg-[#080808] z-50">
        <div className="flex items-center gap-6">
          <span className="font-mono text-sm font-semibold tracking-widest text-white uppercase">
            QUANT AGENT
          </span>
          {/* Desktop nav — hidden on mobile */}
          <nav className="hidden sm:flex items-center gap-1">
            {NAV.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="px-3 py-1 text-xs font-sans text-[#888] hover:text-white transition-colors rounded hover:bg-[#1e1e1e]"
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <SystemStatus />
          <form action="/api/auth/signout" method="POST" className="hidden sm:block">
            <button
              type="submit"
              className="text-xs font-mono text-[#444] hover:text-[#888] transition-colors"
            >
              sign out
            </button>
          </form>
        </div>
      </header>

      {/* Bottom padding accounts for the mobile nav bar */}
      <main className="p-4 sm:p-6 pb-24 sm:pb-6">{children}</main>

      <BottomNav />
    </>
  );
}
