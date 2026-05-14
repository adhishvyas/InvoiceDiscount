import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useWallet } from '../hooks/useWallet';
import { deployInvoice, pyusdToUnits } from '../utils/contract';

interface TierInput {
  cutoffDate: string;  // datetime-local value
  discountPct: string;
}

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  // datetime-local format: YYYY-MM-DDTHH:MM
  return d.toISOString().slice(0, 16);
}

export default function CreateInvoice() {
  const { address, connected, connect } = useWallet();
  const navigate = useNavigate();

  const [amountPyusd, setAmountPyusd] = useState('');
  const [dueDate, setDueDate] = useState(() => daysFromNow(30));
  const [tiers, setTiers] = useState<TierInput[]>([
    { cutoffDate: daysFromNow(0),  discountPct: '15' },
    { cutoffDate: daysFromNow(10), discountPct: '10' },
    { cutoffDate: daysFromNow(20), discountPct: '5' },
  ]);
  const [status, setStatus] = useState<'idle' | 'deploying' | 'done' | 'error'>('idle');
  const [contractId, setContractId] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  function addTier() {
    setTiers(t => [...t, { cutoffDate: '', discountPct: '' }]);
  }
  function removeTier(i: number) {
    setTiers(t => t.filter((_, j) => j !== i));
  }
  function updateTier(i: number, field: keyof TierInput, value: string) {
    setTiers(t => t.map((tier, j) => j === i ? { ...tier, [field]: value } : tier));
  }

  async function handleDeploy() {
    if (!address) { connect(); return; }

    // Validate
    if (!amountPyusd || !dueDate) {
      setErrorMsg('Please fill in all required fields.');
      return;
    }
    const amount = parseFloat(amountPyusd);
    if (isNaN(amount) || amount <= 0) { setErrorMsg('Invalid amount.'); return; }

    const dueDateTs = Math.floor(new Date(dueDate).getTime() / 1000);
    if (dueDateTs <= Math.floor(Date.now() / 1000)) {
      setErrorMsg('Due date must be in the future.');
      return;
    }

    // Build and validate tiers
    const tierList = tiers
      .filter(t => t.cutoffDate && t.discountPct)
      .map(t => ({
        cutoff: Math.floor(new Date(t.cutoffDate).getTime() / 1000),
        discount_bps: Math.round(parseFloat(t.discountPct) * 100),
      }))
      .sort((a, b) => a.cutoff - b.cutoff);

    for (const tier of tierList) {
      if (tier.cutoff >= dueDateTs) { setErrorMsg('All tier cutoff dates must be before the due date.'); return; }
      if (tier.discount_bps <= 0 || tier.discount_bps > 10000) { setErrorMsg('Discount must be between 0.01% and 100%.'); return; }
    }

    setStatus('deploying');
    setErrorMsg('');

    try {
      const id = await deployInvoice({
        seller: address,
        principalUnits: pyusdToUnits(amount),
        dueDate: dueDateTs,
        tiers: tierList,
      });
      setContractId(id);

      // Persist to local storage for the invoices list
      const saved = JSON.parse(localStorage.getItem('invoices') || '[]') as string[];
      localStorage.setItem('invoices', JSON.stringify([id, ...saved]));

      setStatus('done');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Deployment failed');
      setStatus('error');
    }
  }

  function copyId() {
    navigator.clipboard.writeText(contractId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (status === 'done') {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-6">
        <div className="max-w-lg w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center">
          <div className="w-12 h-12 bg-green-900 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold mb-2">Invoice deployed</h2>
          <p className="text-slate-400 text-sm mb-6">Share this contract ID with the buyer so they can fund the invoice.</p>
          <div className="bg-slate-800 rounded-lg px-4 py-3 font-mono text-sm text-slate-200 break-all mb-4">
            {contractId}
          </div>
          <div className="flex gap-3">
            <button onClick={copyId} className="flex-1 bg-slate-700 hover:bg-slate-600 text-sm py-2.5 rounded-lg transition-colors">
              {copied ? 'Copied!' : 'Copy ID'}
            </button>
            <button onClick={() => navigate(`/invoice/${contractId}`)} className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-sm py-2.5 rounded-lg transition-colors">
              View Invoice
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <Link to="/" className="text-slate-400 hover:text-white text-sm transition-colors">← Back</Link>
        <span className="text-sm font-semibold">Create Invoice</span>
        {connected ? (
          <span className="text-xs font-mono bg-slate-800 text-slate-300 px-3 py-1.5 rounded-full">
            {address!.slice(0, 6)}…{address!.slice(-4)}
          </span>
        ) : (
          <button onClick={connect} className="text-sm bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-lg transition-colors">
            Connect
          </button>
        )}
      </nav>

      <div className="max-w-lg mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold mb-8">New Invoice</h1>

        <div className="space-y-6">
          {/* Invoice details */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Invoice Details</h3>

            <div>
              <label className="block text-sm text-slate-300 mb-1.5">Amount <span className="text-slate-500">(PYUSD)</span></label>
              <input
                type="number"
                value={amountPyusd}
                onChange={e => setAmountPyusd(e.target.value)}
                placeholder="1000.00"
                min="0"
                step="0.01"
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm px-3 py-2.5 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-500"
              />
            </div>

            <div>
              <label className="block text-sm text-slate-300 mb-1.5">Due Date</label>
              <input
                type="datetime-local"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm px-3 py-2.5 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Discount tiers */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Discount Tiers</h3>
              <button onClick={addTier} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                + Add tier
              </button>
            </div>
            <p className="text-xs text-slate-500">
              If payment is triggered before a tier's cutoff, the buyer gets that discount.
              Tiers will be applied in order — earliest cutoff first.
            </p>

            {tiers.map((tier, i) => (
              <div key={i} className="flex gap-3 items-start">
                <div className="flex-1">
                  <label className="block text-xs text-slate-500 mb-1">Cutoff date</label>
                  <input
                    type="datetime-local"
                    value={tier.cutoffDate}
                    onChange={e => updateTier(i, 'cutoffDate', e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-white text-xs px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div className="w-28">
                  <label className="block text-xs text-slate-500 mb-1">Discount %</label>
                  <input
                    type="number"
                    value={tier.discountPct}
                    onChange={e => updateTier(i, 'discountPct', e.target.value)}
                    placeholder="10"
                    min="0.01"
                    max="100"
                    step="0.01"
                    className="w-full bg-slate-800 border border-slate-700 text-white text-xs px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                {tiers.length > 1 && (
                  <button onClick={() => removeTier(i)} className="mt-5 text-slate-600 hover:text-red-400 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>

          {errorMsg && (
            <div className="bg-red-950 border border-red-800 text-red-300 text-sm px-4 py-3 rounded-lg">
              {errorMsg}
            </div>
          )}

          <button
            onClick={handleDeploy}
            disabled={status === 'deploying'}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-medium py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {status === 'deploying' ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Deploying…
              </>
            ) : (
              connected ? 'Deploy Invoice Contract' : 'Connect Wallet to Deploy'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
