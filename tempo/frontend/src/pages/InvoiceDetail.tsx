import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { encodeFunctionData, erc20Abi, isAddress, zeroAddress, type Address } from 'viem';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import { invoiceEscrowAbi } from '../abi/InvoiceEscrow';
import { EXPLORER_URL } from '../config';
import { useFund } from '../hooks/useFund';
import { useInvoiceWrite, type WriteState } from '../hooks/useInvoiceWrite';
import { visibleActions } from '../lib/actions';
import { decodeRef } from '../lib/ref';
import { computeSplit } from '../lib/split';
import { STATUS_LABEL, Status, type StatusValue } from '../lib/status';
import { fromUnits } from '../lib/units';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const bpsToPercent = (bps: number) => `${(bps / 100).toString()}%`;
const formatDate = (unix: bigint) => new Date(Number(unix) * 1000).toLocaleString();

function Party({ label, address, account }: { label: string; address: Address; account?: Address }) {
  const none = address === zeroAddress;
  const you = !none && account !== undefined && account.toLowerCase() === address.toLowerCase();
  return (
    <div className="flex justify-between items-center text-sm py-2 border-b border-slate-800 last:border-0">
      <span className="text-slate-400">{label}</span>
      {none ? (
        <span className="text-slate-600">None yet</span>
      ) : (
        <span className="font-mono text-slate-200 flex items-center gap-2">
          <a href={`${EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer" className="hover:underline" title={address}>
            {short(address)}
          </a>
          {you && <span className="text-xs bg-indigo-950 text-indigo-300 border border-indigo-800 px-2 rounded-full font-sans">you</span>}
        </span>
      )}
    </div>
  );
}

function WriteStatus({ state }: { state: WriteState }) {
  if (state.status === 'pending') return <p className="text-sm text-slate-400 mt-3">Waiting for confirmation…</p>;
  if (state.status === 'error') return <p className="text-sm text-red-400 mt-3">{state.message}</p>;
  if (state.status === 'success') {
    const hash = state.receipts[state.receipts.length - 1].transactionHash;
    return (
      <p className="text-sm text-green-400 mt-3">
        Confirmed.{' '}
        <a href={`${EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer" className="underline">
          View transaction
        </a>
      </p>
    );
  }
  return null;
}

export default function InvoiceDetail() {
  const { address: param } = useParams();
  if (!param || !isAddress(param)) {
    return <main className="max-w-xl mx-auto px-6 py-16 text-red-400">Not a valid invoice address.</main>;
  }
  return <Invoice invoice={param} />;
}

function Invoice({ invoice }: { invoice: Address }) {
  const { address: account } = useAccount();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [refundInput, setRefundInput] = useState('');

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(timer);
  }, []);

  const { data: inv, error, refetch } = useReadContract({ address: invoice, abi: invoiceEscrowAbi, functionName: 'getInvoice' });
  const token = inv?.token;
  const { data: meta } = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: token ?? zeroAddress, abi: erc20Abi, functionName: 'symbol' },
      { address: token ?? zeroAddress, abi: erc20Abi, functionName: 'decimals' },
    ] as const,
    query: { enabled: Boolean(token) },
  });
  const { data: bps } = useReadContract({
    address: invoice,
    abi: invoiceEscrowAbi,
    functionName: 'activeDiscount',
    args: [BigInt(now)],
  });

  const { state: fundState, fund, reset: resetFund } = useFund();
  const { state: txState, run, reset: resetTx } = useInvoiceWrite();

  if (error) return <main className="max-w-xl mx-auto px-6 py-16 text-red-400">Could not read this invoice: {error.message}</main>;
  if (!inv || !meta) return <main className="max-w-xl mx-auto px-6 py-16 text-slate-400">Loading…</main>;

  const [symbol, decimals] = meta;
  const status = inv.status as StatusValue;
  const money = (units: bigint) => `${fromUnits(units, decimals)} ${symbol}`;
  const actions = visibleActions({
    account,
    seller: inv.seller,
    buyer: inv.buyer,
    status,
    dueDate: inv.dueDate,
    now: BigInt(now),
  });
  const open = status === Status.Active || status === Status.Funded;
  const discount = bps ?? 0;
  const split = computeSplit(inv.principal, discount);
  const activeTier = inv.tiers.findIndex((t) => BigInt(now) < t.cutoff);

  const refundTarget = refundInput.trim() === '' ? account : (refundInput.trim() as Address);
  const refundValid = refundInput.trim() === '' || isAddress(refundInput.trim());

  const onFund = async () => {
    if (!account || !refundValid) return;
    const receipts = await fund(invoice, inv.token, inv.principal, (refundInput.trim() || zeroAddress) as Address);
    if (receipts) refetch();
  };
  const onCall = async (functionName: 'triggerPayment' | 'cancel') => {
    const receipts = await run([{ to: invoice, data: encodeFunctionData({ abi: invoiceEscrowAbi, functionName }) }]);
    if (receipts) refetch();
  };

  const payoutLine = `${money(split.toSeller)} to ${short(inv.payoutAddress)}`;
  const refundLine = split.refund > 0n ? `${money(split.refund)} refunded to ${short(inv.refundAddress)}` : 'no refund';

  return (
    <main className="max-w-xl mx-auto px-6 py-12 space-y-8">
      <header>
        <p className="text-xs uppercase tracking-widest text-slate-500 mb-1">Invoice</p>
        <h1 className="text-3xl font-bold tracking-tight break-all">{decodeRef(inv.invoiceRef)}</h1>
        <div className="flex items-center gap-3 mt-3 text-sm">
          <span className="bg-slate-800 px-3 py-1 rounded-full">{STATUS_LABEL[status]}</span>
          <span className="text-slate-300 font-medium">{money(inv.principal)}</span>
          <span className="text-slate-500">due {formatDate(inv.dueDate)}</span>
        </div>
      </header>

      <section className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-2">
        <Party label="Seller" address={inv.seller} account={account} />
        <Party label="Payout address" address={inv.payoutAddress} account={account} />
        <Party label="Buyer" address={inv.buyer} account={account} />
        <Party label="Refund address" address={inv.refundAddress} account={account} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-3">Early-payment discounts</h2>
        {inv.tiers.length === 0 ? (
          <p className="text-sm text-slate-500">None. The full amount is paid whenever payment is triggered.</p>
        ) : (
          <ul className="space-y-2">
            {inv.tiers.map((t, i) => {
              const active = open && i === activeTier;
              return (
                <li
                  key={i}
                  className={`flex justify-between text-sm rounded-lg px-4 py-2 border ${
                    active ? 'border-indigo-500 bg-indigo-950 text-white' : 'border-slate-800 bg-slate-900 text-slate-400'
                  }`}
                >
                  <span>Before {formatDate(t.cutoff)}</span>
                  <span className="font-medium">{bpsToPercent(t.discountBps)} off{active ? ' (now)' : ''}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {open && (
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 text-sm">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-3">If paid now ({bpsToPercent(discount)} off)</h2>
          <p>{payoutLine}</p>
          <p className="text-slate-400">{status === Status.Funded ? refundLine : split.refund > 0n ? `${money(split.refund)} refunded to the buyer` : 'no refund'}</p>
        </section>
      )}

      {(actions.fund || actions.trigger || actions.cancel) && (
        <section className="space-y-6">
          {actions.fund && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="font-semibold mb-3">Fund this invoice</h2>
              <label className="block text-sm text-slate-300 mb-1.5">Refund address (optional)</label>
              <input
                value={refundInput}
                onChange={(e) => setRefundInput(e.target.value)}
                placeholder="Your connected wallet"
                className="w-full bg-slate-800 border border-slate-700 text-white text-sm font-mono px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-500"
              />
              {!refundValid && <p className="text-xs text-red-400 mt-1">Enter a valid address</p>}
              <p className="text-sm text-slate-400 mt-3">
                You lock {money(inv.principal)} in escrow. Any discount, or the full amount if the invoice is cancelled, is
                refunded to {refundTarget ? short(refundTarget) : 'your wallet'}.
              </p>
              <button
                onClick={() => { resetFund(); void onFund(); }}
                disabled={!refundValid || fundState.status === 'pending'}
                className="mt-4 bg-indigo-600 hover:bg-indigo-500 px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {fundState.status === 'pending' ? 'Funding…' : 'Fund invoice'}
              </button>
              <WriteStatus state={fundState} />
            </div>
          )}

          {(actions.trigger || actions.cancel) && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">
              {actions.trigger && (
                <div>
                  <h2 className="font-semibold mb-1">Trigger payment</h2>
                  <p className="text-sm text-slate-400">{payoutLine}; {refundLine}.</p>
                  <button
                    onClick={() => { resetTx(); void onCall('triggerPayment'); }}
                    disabled={txState.status === 'pending'}
                    className="mt-3 bg-indigo-600 hover:bg-indigo-500 px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    Trigger payment
                  </button>
                </div>
              )}
              {actions.cancel && (
                <div>
                  <h2 className="font-semibold mb-1">Cancel invoice</h2>
                  <p className="text-sm text-slate-400">
                    {status === Status.Funded
                      ? `${money(inv.principal)} is returned to ${short(inv.refundAddress)}.`
                      : 'The invoice is closed. No funds move.'}
                  </p>
                  <button
                    onClick={() => { resetTx(); void onCall('cancel'); }}
                    disabled={txState.status === 'pending'}
                    className="mt-3 bg-slate-700 hover:bg-slate-600 px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    Cancel invoice
                  </button>
                </div>
              )}
              <WriteStatus state={txState} />
            </div>
          )}
        </section>
      )}
    </main>
  );
}
