import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../hooks/useWallet';

export default function Home() {
  const { address, connected, connect, loading } = useWallet();
  const [lookupId, setLookupId] = useState('');
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Nav */}
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">InvoiceDiscount</span>
        {connected ? (
          <span className="text-xs font-mono bg-slate-800 text-slate-300 px-3 py-1.5 rounded-full">
            {address!.slice(0, 6)}…{address!.slice(-4)}
          </span>
        ) : (
          <button
            onClick={connect}
            disabled={loading}
            className="text-sm bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            Connect Freighter
          </button>
        )}
      </nav>

      {/* Hero */}
      <div className="max-w-2xl mx-auto px-6 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 text-xs font-medium bg-indigo-950 text-indigo-300 border border-indigo-800 px-3 py-1 rounded-full mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
          Stellar Testnet · PYUSD
        </div>

        <h1 className="text-4xl font-bold tracking-tight mb-4">
          Invoice discounting,<br />on-chain
        </h1>
        <p className="text-slate-400 text-lg leading-relaxed mb-12">
          Sellers get paid early. Buyers capture discounts. No emails, no
          negotiation — the terms are locked in a smart contract at invoice
          creation.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-16">
          <button
            onClick={() => connected ? navigate('/create') : connect()}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 py-3 rounded-lg transition-colors"
          >
            {connected ? 'Create Invoice' : 'Connect to Create Invoice'}
          </button>
        </div>

        {/* Lookup */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-left">
          <p className="text-sm text-slate-400 mb-3">Look up an existing invoice by contract ID</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={lookupId}
              onChange={e => setLookupId(e.target.value)}
              placeholder="C…"
              className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm font-mono px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-500"
            />
            <button
              onClick={() => lookupId.trim() && navigate(`/invoice/${lookupId.trim()}`)}
              className="bg-slate-700 hover:bg-slate-600 text-white text-sm px-4 py-2 rounded-lg transition-colors"
            >
              View
            </button>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div className="max-w-2xl mx-auto px-6 pb-24">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-8">How it works</h2>
        <div className="space-y-4">
          {[
            { step: '01', who: 'Seller', action: 'Creates an invoice contract with discount tiers and a due date. Shares the contract ID with the buyer.' },
            { step: '02', who: 'Buyer', action: 'Reviews the terms and locks the full invoice amount in the contract. Funds are guaranteed for the seller.' },
            { step: '03', who: 'Either', action: 'Triggers payment at any time. The smart contract calculates the applicable discount and disburses funds instantly.' },
          ].map(({ step, who, action }) => (
            <div key={step} className="flex gap-4 bg-slate-900 border border-slate-800 rounded-xl p-5">
              <span className="text-2xl font-bold text-slate-700 tabular-nums w-8 shrink-0">{step}</span>
              <div>
                <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wide">{who}</span>
                <p className="text-slate-300 text-sm mt-1">{action}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
