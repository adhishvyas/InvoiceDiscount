import { Link, Outlet } from 'react-router-dom';
import ConnectButton from './ConnectButton';

export default function Layout() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <Link to="/" className="text-lg font-semibold tracking-tight">InvoiceDiscount</Link>
        <div className="flex items-center gap-4">
          <span className="hidden sm:inline text-xs font-medium bg-indigo-950 text-indigo-300 border border-indigo-800 px-3 py-1 rounded-full">
            Tempo Testnet
          </span>
          <ConnectButton />
        </div>
      </nav>
      <Outlet />
    </div>
  );
}
