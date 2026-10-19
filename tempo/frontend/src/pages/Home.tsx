import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAddress } from 'viem';

const STEPS = [
  { step: '01', who: 'Seller', action: 'Creates an invoice with discount tiers and a due date, then shares the invoice address with the buyer.' },
  { step: '02', who: 'Buyer', action: 'Reviews the terms and locks the full invoice amount in escrow. The seller is guaranteed payment.' },
  { step: '03', who: 'Either', action: 'Triggers payment. The contract applies the discount tier in force and pays both sides instantly.' },
];

export default function Home() {
  const [lookup, setLookup] = useState('');
  const [error, setError] = useState<string>();
  const navigate = useNavigate();

  const view = () => {
    const value = lookup.trim();
    if (!isAddress(value)) {
      setError('Enter a valid invoice address (0x…)');
      return;
    }
    setError(undefined);
    navigate(`/invoice/${value}`);
  };

  return (
    <>
      <div className="max-w-2xl mx-auto px-6 pt-24 pb-16 text-center">
        <h1 className="text-4xl font-bold tracking-tight mb-4">
          Invoice discounting,<br />on-chain
        </h1>
        <p className="text-slate-400 text-lg leading-relaxed mb-12">
          Sellers get paid early. Buyers capture discounts. No emails, no negotiation: the terms are locked in a smart
          contract when the invoice is created.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-16">
          <button
            onClick={() => navigate('/create')}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 py-3 rounded-lg transition-colors"
          >
            Create Invoice
          </button>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-left">
          <p className="text-sm text-slate-400 mb-3">Look up an existing invoice by address</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && view()}
              placeholder="0x…"
              aria-invalid={error !== undefined}
              className="flex-1 bg-slate-800 border border-slate-700 text-white text-sm font-mono px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-500"
            />
            <button
              onClick={view}
              className="bg-slate-700 hover:bg-slate-600 text-white text-sm px-4 py-2 rounded-lg transition-colors"
            >
              View
            </button>
          </div>
          {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-6 pb-24">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-8">How it works</h2>
        <div className="space-y-4">
          {STEPS.map(({ step, who, action }) => (
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
    </>
  );
}
