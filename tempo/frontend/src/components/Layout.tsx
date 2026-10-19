import { Link, Outlet } from 'react-router-dom';

export default function Layout() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <Link to="/" className="text-lg font-semibold tracking-tight">InvoiceDiscount</Link>
        <span className="text-xs font-medium bg-indigo-950 text-indigo-300 border border-indigo-800 px-3 py-1 rounded-full">
          Tempo Testnet
        </span>
      </nav>
      <Outlet />
    </div>
  );
}
