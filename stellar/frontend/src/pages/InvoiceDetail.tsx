import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useWallet } from '../hooks/useWallet';
import {
  getInvoice,
  fundInvoice,
  triggerPayment,
  cancelInvoice,
  addPyusdTrustline,
  unitsToPyusd,
  activeDiscount,
  type InvoiceState,
  type InvoiceStatus,
} from '../utils/contract';

const STATUS_COLORS: Record<InvoiceStatus, string> = {
  Active:    'bg-amber-900 text-amber-300 border-amber-700',
  Funded:    'bg-blue-900 text-blue-300 border-blue-700',
  Paid:      'bg-green-900 text-green-300 border-green-700',
  Cancelled: 'bg-slate-800 text-slate-400 border-slate-600',
};

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatCountdown(targetTs: number): string {
  const diff = targetTs - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'Passed';
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function shortenAddress(addr: string) {
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

export default function InvoiceDetail() {
  const { contractId } = useParams<{ contractId: string }>();
  const { address, connected, connect } = useWallet();

  const [invoice, setInvoice] = useState<InvoiceState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [txStatus, setTxStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [txMsg, setTxMsg] = useState('');
  const [copied, setCopied] = useState(false);

  async function load() {
    if (!contractId) return;
    setLoading(true);
    setLoadError('');
    try {
      const state = await getInvoice(contractId, address ?? undefined);
      setInvoice(state);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load invoice');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [contractId, address]);

  async function withTx(label: string, fn: () => Promise<void>) {
    setTxStatus('pending');
    setTxMsg('');
    try {
      await fn();
      setTxMsg(`${label} successful`);
      setTxStatus('done');
      await load();
    } catch (e) {
      setTxMsg(e instanceof Error ? e.message : `${label} failed`);
      setTxStatus('error');
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const isSeller = invoice?.seller === address;
  const isBuyer = invoice?.buyer === address;
  const canFund = connected && !isSeller && invoice?.status === 'Active';
  const currentDiscountBps = invoice ? activeDiscount(invoice.tiers, now) : 0;
  const discountPct = currentDiscountBps / 100;
  const principalPyusd = invoice ? unitsToPyusd(invoice.principal) : 0;
  const paymentAmount = invoice ? principalPyusd * (1 - currentDiscountBps / 10000) : 0;
  const savings = principalPyusd - paymentAmount;

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <Link to="/" className="text-slate-400 hover:text-white text-sm transition-colors">← Home</Link>
        {connected && address ? (
          <span className="text-xs font-mono bg-slate-800 text-slate-300 px-3 py-1.5 rounded-full">
            {address.slice(0, 6)}…{address.slice(-4)}
          </span>
        ) : (
          <button onClick={connect} className="text-sm bg-indigo-600 hover:bg-indigo-500 px-4 py-1.5 rounded-lg transition-colors">
            Connect
          </button>
        )}
      </nav>

      <div className="max-w-lg mx-auto px-6 py-12">
        {/* Contract ID header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="min-w-0">
            <p className="text-xs text-slate-500 mb-1">Contract</p>
            <button
              onClick={() => { navigator.clipboard.writeText(contractId!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="font-mono text-sm text-slate-300 hover:text-white transition-colors truncate max-w-xs block"
            >
              {copied ? 'Copied!' : `${contractId?.slice(0, 16)}…`}
            </button>
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-3 text-slate-400">
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            Loading invoice…
          </div>
        )}

        {loadError && (
          <div className="bg-red-950 border border-red-800 text-red-300 text-sm px-4 py-3 rounded-lg">
            {loadError}
          </div>
        )}

        {invoice && !loading && (
          <div className="space-y-5">
            {/* Status + amount */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="text-3xl font-bold">{principalPyusd.toLocaleString()} <span className="text-slate-400 text-xl font-normal">PYUSD</span></p>
                  <p className="text-xs text-slate-500 mt-1">Due {formatDate(invoice.due_date)}</p>
                </div>
                <span className={`text-xs font-semibold border px-2.5 py-1 rounded-full ${STATUS_COLORS[invoice.status]}`}>
                  {invoice.status}
                </span>
              </div>

              {/* Parties */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-slate-800 rounded-lg p-3">
                  <p className="text-slate-500 mb-1">Seller</p>
                  <p className="font-mono text-slate-300 flex items-center gap-1">
                    {shortenAddress(invoice.seller)}
                    {isSeller && <span className="text-indigo-400">(you)</span>}
                  </p>
                </div>
                <div className="bg-slate-800 rounded-lg p-3">
                  <p className="text-slate-500 mb-1">Buyer</p>
                  <p className="font-mono text-slate-300 flex items-center gap-1">
                    {invoice.buyer ? shortenAddress(invoice.buyer) : <span className="text-slate-500 italic">Unfunded</span>}
                    {isBuyer && <span className="text-indigo-400">(you)</span>}
                  </p>
                </div>
              </div>
            </div>

            {/* Current discount callout */}
            {invoice.status === 'Funded' && now < invoice.due_date && (
              <div className={`rounded-xl p-5 border ${currentDiscountBps > 0 ? 'bg-green-950 border-green-800' : 'bg-slate-900 border-slate-800'}`}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Trigger payment now</p>
                {currentDiscountBps > 0 ? (
                  <>
                    <p className="text-2xl font-bold text-green-300">{discountPct}% discount applies</p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p className="text-slate-400 text-xs">Seller receives</p>
                        <p className="font-semibold">{paymentAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} PYUSD</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">Buyer saves</p>
                        <p className="font-semibold text-green-300">{savings.toLocaleString(undefined, { maximumFractionDigits: 2 })} PYUSD</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-slate-300">No discount — full amount of <span className="font-semibold">{principalPyusd.toLocaleString()} PYUSD</span> will be paid</p>
                )}
              </div>
            )}

            {/* Discount tiers timeline */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-4">Discount Tiers</h3>
              <div className="space-y-3">
                {invoice.tiers.map((tier, i) => {
                  const isPast = now >= tier.cutoff;
                  const isActive = !isPast && (i === 0 || now >= invoice.tiers[i - 1].cutoff);
                  return (
                    <div key={i} className={`flex items-center justify-between text-sm rounded-lg px-3 py-2.5 ${isActive ? 'bg-green-950 border border-green-800' : isPast ? 'opacity-40 bg-slate-800' : 'bg-slate-800'}`}>
                      <div>
                        <p className={`font-semibold ${isActive ? 'text-green-300' : 'text-slate-200'}`}>
                          {(tier.discount_bps / 100).toFixed(2)}% off
                          {isActive && <span className="ml-2 text-xs font-normal text-green-400">← active now</span>}
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5">Before {formatDate(tier.cutoff)}</p>
                      </div>
                      <span className={`text-xs font-mono ${isPast ? 'text-slate-600' : 'text-slate-400'}`}>
                        {isPast ? 'Expired' : formatCountdown(tier.cutoff)}
                      </span>
                    </div>
                  );
                })}
                <div className={`flex items-center justify-between text-sm rounded-lg px-3 py-2.5 bg-slate-800 ${now >= invoice.due_date && invoice.status === 'Funded' ? 'border border-amber-700' : ''}`}>
                  <div>
                    <p className="text-slate-200 font-semibold">0% — full payment</p>
                    <p className="text-xs text-slate-400 mt-0.5">Due date: {formatDate(invoice.due_date)}</p>
                  </div>
                  <span className="text-xs font-mono text-slate-400">
                    {now >= invoice.due_date ? 'Due' : formatCountdown(invoice.due_date)}
                  </span>
                </div>
              </div>
            </div>

            {/* Actions */}
            {(invoice.status === 'Active' || invoice.status === 'Funded') && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-3">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Actions</h3>

                {!connected ? (
                  <button
                    onClick={connect}
                    className="w-full text-sm bg-indigo-600 hover:bg-indigo-500 py-2.5 rounded-lg transition-colors font-medium"
                  >
                    Connect Wallet to Act
                  </button>
                ) : (
                  <>
                    {/* Add trustline */}
                    {canFund && (
                      <button
                        onClick={() => withTx('Add trustline', () => addPyusdTrustline(address!))}
                        disabled={txStatus === 'pending'}
                        className="w-full text-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 py-2.5 rounded-lg transition-colors"
                      >
                        Add PYUSD Trustline (if needed)
                      </button>
                    )}

                    {/* Fund */}
                    {canFund && (
                      <button
                        onClick={() => withTx('Fund', () => fundInvoice(contractId!, address!))}
                        disabled={txStatus === 'pending'}
                        className="w-full text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 py-2.5 rounded-lg transition-colors font-medium"
                      >
                        Fund Invoice ({principalPyusd.toLocaleString()} PYUSD)
                      </button>
                    )}

                    {/* Trigger payment */}
                    {invoice.status === 'Funded' && (isSeller || isBuyer) && (
                      <button
                        onClick={() => withTx('Payment', () => triggerPayment(contractId!, address!))}
                        disabled={txStatus === 'pending'}
                        className="w-full text-sm bg-green-700 hover:bg-green-600 disabled:opacity-50 py-2.5 rounded-lg transition-colors font-medium"
                      >
                        {currentDiscountBps > 0
                          ? `Trigger Payment — ${discountPct}% discount`
                          : 'Trigger Full Payment'}
                      </button>
                    )}

                    {/* Cancel */}
                    {(isSeller || (isBuyer && now > invoice.due_date)) && (
                      <button
                        onClick={() => withTx('Cancel', () => cancelInvoice(contractId!, address!))}
                        disabled={txStatus === 'pending'}
                        className="w-full text-sm bg-slate-800 hover:bg-red-950 hover:text-red-300 disabled:opacity-50 py-2.5 rounded-lg transition-colors text-slate-400"
                      >
                        Cancel Invoice
                      </button>
                    )}
                  </>
                )}

                {txStatus === 'pending' && (
                  <div className="flex items-center gap-2 text-sm text-slate-400">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    Waiting for confirmation…
                  </div>
                )}
                {txStatus === 'done' && <p className="text-sm text-green-400">{txMsg}</p>}
                {txStatus === 'error' && <p className="text-sm text-red-400">{txMsg}</p>}
              </div>
            )}

            {/* Terminal states */}
            {invoice.status === 'Paid' && (
              <div className="bg-green-950 border border-green-800 rounded-xl p-5 text-center">
                <p className="text-green-300 font-semibold">Invoice paid</p>
                <p className="text-slate-400 text-sm mt-1">
                  Seller received {paymentAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} PYUSD
                </p>
              </div>
            )}
            {invoice.status === 'Cancelled' && (
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 text-center">
                <p className="text-slate-300 font-semibold">Invoice cancelled</p>
                {invoice.status === 'Cancelled' && (
                  <p className="text-slate-500 text-sm mt-1">Any locked funds have been returned to the buyer</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
