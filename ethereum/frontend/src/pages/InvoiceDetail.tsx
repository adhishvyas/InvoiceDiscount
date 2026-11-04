import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { erc20Abi, isAddress, zeroAddress, type Address } from 'viem';
import { useAccount, useBalance, useReadContract, useReadContracts } from 'wagmi';
import { invoiceEscrowAbi } from '../abi/InvoiceEscrow';
import { EXPLORER_URL, MESH_SERVER_URL, MESH_TOKENS } from '../config';
import { useFund } from '../hooks/useFund';
import { useInvoiceHistory } from '../hooks/useInvoiceHistory';
import { useInvoiceWrite, type WriteState } from '../hooks/useInvoiceWrite';
import { useMeshPay, useMeshSessions } from '../hooks/useMeshPay';
import { visibleActions } from '../lib/actions';
import { upcomingCutoff } from '../lib/cutoff';
import type { InvoiceHistory } from '../lib/history';
import type { SessionView } from '../lib/meshSession';
import { decodeRef } from '../lib/ref';
import { computeSplit } from '../lib/split';
import { STATUS_LABEL, Status, type StatusValue } from '../lib/status';
import { isNative, NATIVE_DECIMALS } from '../lib/tokens';
import { fromUnits } from '../lib/units';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const bpsToPercent = (bps: number) => `${(bps / 100).toString()}%`;
const formatDate = (unix: bigint) => new Date(Number(unix) * 1000).toLocaleString();
const formatTime = (unix: bigint) => new Date(Number(unix) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const txLink = (hash: string) => (
  <a href={`${EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer" className="font-mono underline break-all">
    {hash}
  </a>
);

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

function Actor({ address, account }: { address: Address; account?: Address }) {
  const you = account !== undefined && account.toLowerCase() === address.toLowerCase();
  return (
    <span className="font-mono">
      <a href={`${EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer" className="hover:underline" title={address}>
        {short(address)}
      </a>
      {you && <span className="ml-2 text-xs bg-indigo-950 text-indigo-300 border border-indigo-800 px-2 rounded-full font-sans">you</span>}
    </span>
  );
}

function TimelineRow({
  label,
  at,
  tx,
  actor,
  account,
  actorFirst,
}: {
  label: string;
  at?: bigint;
  tx?: string;
  actor?: Address;
  account?: Address;
  actorFirst?: boolean;
}) {
  return (
    <li className="flex justify-between gap-4 text-sm py-2 border-b border-slate-800 last:border-0">
      <span className={at === undefined ? 'text-slate-600' : 'text-slate-200 font-medium'}>{label}</span>
      {at === undefined ? (
        <span className="text-slate-600">Not yet</span>
      ) : (
        <span className="text-right text-slate-400">
          {actor && actorFirst && (
            <>
              <Actor address={actor} account={account} /> on{' '}
            </>
          )}
          {formatDate(at)}
          {actor && !actorFirst && (
            <>
              {' '}by <Actor address={actor} account={account} />
            </>
          )}
          {tx && (
            <>
              {' '}
              <a href={`${EXPLORER_URL}/tx/${tx}`} target="_blank" rel="noreferrer" className="underline">
                tx
              </a>
            </>
          )}
        </span>
      )}
    </li>
  );
}

function Timeline({
  history,
  status,
  account,
  money,
}: {
  history: InvoiceHistory;
  status: StatusValue;
  account?: Address;
  money: (units: bigint) => string;
}) {
  const { created, funded, paid, cancelled, settledDirect, inbound, deferred, withdrawals } = history;
  const open = status === Status.Active || status === Status.Funded;
  return (
    <ul>
      <TimelineRow label="Created" at={created?.timestamp} tx={created?.tx} actor={created?.seller} account={account} />
      {(funded || open) && <TimelineRow label="Funded" at={funded?.timestamp} tx={funded?.tx} actor={funded?.buyer} account={account} />}
      {inbound?.map((t) => (
        <TimelineRow key={t.tx} label={`Paid ${money(t.amount)} directly`} at={t.timestamp} tx={t.tx} actor={t.from} account={account} />
      ))}
      {settledDirect ? (
        <>
          <TimelineRow
            label="Settled directly"
            at={settledDirect.timestamp}
            tx={settledDirect.tx}
            actor={settledDirect.caller}
            account={account}
          />
        </>
      ) : cancelled ? (
        <TimelineRow label="Cancelled" at={cancelled.timestamp} tx={cancelled.tx} actor={cancelled.caller} account={account} />
      ) : (
        <TimelineRow
          label={paid ? 'Triggered by' : 'Paid'}
          at={paid?.timestamp}
          tx={paid?.tx}
          actor={paid?.caller}
          account={account}
          actorFirst
        />
      )}
      {deferred?.map((d, i) => (
        <TimelineRow
          key={`deferred-${d.tx}-${i}`}
          label={`${money(d.amount)} held for withdrawal (couldn’t be sent)`}
          at={d.timestamp}
          tx={d.tx}
          actor={d.to}
          account={account}
          actorFirst
        />
      ))}
      {withdrawals?.map((w, i) => (
        <TimelineRow
          key={`withdrawn-${w.tx}-${i}`}
          label={`Withdrew ${money(w.amount)}`}
          at={w.timestamp}
          tx={w.tx}
          actor={w.account}
          account={account}
        />
      ))}
    </ul>
  );
}

function Settlement({
  history,
  principal,
  dueDate,
  money,
  account,
}: {
  history: InvoiceHistory;
  principal: bigint;
  dueDate: bigint;
  money: (units: bigint) => string;
  account?: Address;
}) {
  const { paid, cancelled, settledDirect } = history;
  if (settledDirect) {
    const discount = principal - settledDirect.amount;
    return (
      <>
        <div className="flex justify-between text-sm py-2 border-b border-slate-800">
          <span className="text-slate-400">Seller payout</span>
          <span>
            <span className="font-medium text-slate-200">{money(settledDirect.amount)}</span> to{' '}
            <Actor address={settledDirect.payoutAddress} account={account} />
          </span>
        </div>
        <div className="flex justify-between text-sm py-2 border-b border-slate-800 last:border-0">
          <span className="text-slate-400">Payer discount ({bpsToPercent(settledDirect.discountBps)} tier)</span>
          <span className="font-medium text-slate-200">{discount > 0n ? `${money(discount)} not paid` : 'none'}</span>
        </div>
        <p className="text-xs text-slate-500 pt-2">Paid directly with no escrow, so no refund.</p>
      </>
    );
  }
  if (paid) {
    const line = (label: string, amount: bigint, to: Address) => (
      <div className="flex justify-between text-sm py-2 border-b border-slate-800 last:border-0">
        <span className="text-slate-400">{label}</span>
        <span>
          <span className="font-medium text-slate-200">{money(amount)}</span> to <Actor address={to} account={account} />
        </span>
      </div>
    );
    return (
      <>
        {line('Seller payout', paid.toSeller, paid.payoutAddress)}
        {line(`Buyer discount (${bpsToPercent(paid.discountBps)})`, paid.refundToBuyer, paid.refundAddress)}
        <p className="text-xs text-slate-500 pt-2">
          Triggered {paid.timestamp > dueDate ? 'after' : 'before'} the due date.
        </p>
      </>
    );
  }
  if (cancelled) {
    return (
      <p className="text-sm text-slate-400">
        {cancelled.refunded > 0n ? `${money(cancelled.refunded)} was returned to the buyer's refund address.` : 'No funds moved.'}
      </p>
    );
  }
  return null;
}

/** The spec §5.3 warning when a tier cutoff is close: the block that includes the transaction decides the tier. */
function CutoffWarning({ cutoff }: { cutoff: bigint | undefined }) {
  if (cutoff === undefined) return null;
  return (
    <p className="text-sm text-amber-300 mt-3">
      A discount tier ends at {formatTime(cutoff)}. If the transaction is included after that, the split changes.
    </p>
  );
}

/** The Mesh session's progress once Mesh Link has closed (Mesh spec §5; Link doesn't say whether the buyer paid). */
function MeshProgress({ session, onRetry }: { session: SessionView | undefined; onRetry: () => void }) {
  switch (session?.state) {
    case undefined:
    case 'awaiting-transfer':
      return <p className="text-sm text-slate-400 mt-3">Mesh closed. Checking for your payment…</p>;
    case 'pending':
      return <p className="text-sm text-slate-400 mt-3">Mesh reports the transfer as pending…</p>;
    case 'succeeded':
      return <p className="text-sm text-slate-400 mt-3">Transfer received. Settling the invoice…</p>;
    case 'settled':
      return (
        <p className="text-sm text-green-400 mt-3">
          Paid and settled.{' '}
          {session.settleTx && (
            <a href={`${EXPLORER_URL}/tx/${session.settleTx}`} target="_blank" rel="noreferrer" className="underline">
              View transaction
            </a>
          )}
        </p>
      );
    case 'failed':
      return (
        <p className="text-sm text-red-400 mt-3">
          The transfer failed.{' '}
          <button onClick={onRetry} className="underline">
            Try again
          </button>
        </p>
      );
    case 'needs-attention':
      return (
        <p className="text-sm text-amber-300 mt-3">
          The payment needs attention: {session.reason ?? 'the invoice was not settled'}. If the funds reached the invoice, anyone
          can use Finish settlement, or the seller can use Accept and settle for a short payment (both need a connected wallet).
        </p>
      );
  }
}

/** "Paid via Mesh" from the invoice's latest session, while mesh-server still holds it. */
function PaidViaMesh({ session }: { session: SessionView | undefined }) {
  if (!session || !['succeeded', 'settled', 'needs-attention'].includes(session.state)) return null;
  const { provider, sourceAddress } = session.payer ?? {};
  return (
    <p className="text-xs text-slate-500 py-2">
      Paid via Mesh{provider && <> from {provider}</>}
      {sourceAddress && (
        <>
          ; sent by <span className="font-mono break-all">{sourceAddress}</span>
        </>
      )}
      .
    </p>
  );
}

function WriteStatus({ state }: { state: WriteState }) {
  if (state.status === 'pending') {
    return (
      <p className="text-sm text-slate-400 mt-3">
        Waiting for confirmation (about 12 s)…{state.hash && <> {txLink(state.hash)}</>}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <p className="text-sm text-red-400 mt-3">
        {state.message}
        {state.hash && <> {txLink(state.hash)}</>}
      </p>
    );
  }
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
  const native = token !== undefined && isNative(token);
  const erc20 = token !== undefined && !native;
  const { data: erc20Meta } = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: token ?? zeroAddress, abi: erc20Abi, functionName: 'symbol' },
      { address: token ?? zeroAddress, abi: erc20Abi, functionName: 'decimals' },
    ] as const,
    query: { enabled: erc20 },
  });
  // ETH has no symbol() or decimals() (native-ETH spec §4).
  const meta = native ? (['ETH', NATIVE_DECIMALS] as const) : erc20Meta;
  const { data: tokenBalance, refetch: refetchTokenBalance } = useReadContract({
    address: token ?? zeroAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [invoice],
    query: { enabled: erc20 },
  });
  const { data: ethBalance, refetch: refetchEthBalance } = useBalance({ address: invoice, query: { enabled: native } });
  const cloneBalance = native ? ethBalance?.value : tokenBalance;
  const refetchBalance = () => {
    if (native) void refetchEthBalance();
    else void refetchTokenBalance();
  };
  const { data: owed, refetch: refetchOwed } = useReadContract({
    address: invoice,
    abi: invoiceEscrowAbi,
    functionName: 'owed',
    args: [account ?? zeroAddress],
    query: { enabled: account !== undefined },
  });
  const { data: bps } = useReadContract({
    address: invoice,
    abi: invoiceEscrowAbi,
    functionName: 'activeDiscount',
    args: [BigInt(now)],
  });

  const { data: history, isError: historyError, refetch: refetchHistory } = useInvoiceHistory(invoice, inv?.token, inv?.status ?? -1);

  const { state: fundState, fund, reset: resetFund, path: fundPath } = useFund(token);
  const { state: txState, run, reset: resetTx, wrongChain } = useInvoiceWrite();
  const [confirmAccept, setConfirmAccept] = useState(false);

  const meshSupported =
    MESH_SERVER_URL !== undefined && token !== undefined && MESH_TOKENS.some((t) => t.address.toLowerCase() === token.toLowerCase());
  const mesh = useMeshPay(() => {
    refetch();
    refetchBalance();
    refetchHistory();
  });
  const { data: meshSessions } = useMeshSessions(invoice, meshSupported);

  if (error) return <main className="max-w-xl mx-auto px-6 py-16 text-red-400">Could not read this invoice: {error.message}</main>;
  if (!inv || !meta) return <main className="max-w-xl mx-auto px-6 py-16 text-slate-400">Loading…</main>;

  const [symbol, decimals] = meta;
  const status = inv.status as StatusValue;
  const money = (units: bigint) => `${fromUnits(units, decimals)} ${symbol}`;
  const open = status === Status.Active || status === Status.Funded;
  const discount = bps ?? 0;
  const split = computeSplit(inv.principal, discount);
  const balance = cloneBalance ?? 0n;
  const actions = visibleActions({
    account,
    seller: inv.seller,
    buyer: inv.buyer,
    status,
    dueDate: inv.dueDate,
    now: BigInt(now),
    cloneBalance: balance,
    dueNow: split.toSeller,
    meshSupported,
    owed: account === undefined ? 0n : (owed ?? 0n),
  });
  const activeTier = inv.tiers.findIndex((t) => BigInt(now) < t.cutoff);
  const nextCutoff = upcomingCutoff(inv.tiers, BigInt(now));
  const escrowRef = (history?.funded ?? history?.paid ?? history?.cancelled ?? history?.settledDirect)?.invoiceRef;

  const refundTarget = refundInput.trim() === '' ? account : (refundInput.trim() as Address);
  const refundValid = refundInput.trim() === '' || isAddress(refundInput.trim());

  const onFund = async () => {
    if (!account || !refundValid) return;
    const receipts = await fund(invoice, inv.token, inv.principal, (refundInput.trim() || zeroAddress) as Address);
    if (receipts) refetch();
  };
  const onCall = async (functionName: 'triggerPayment' | 'cancel' | 'settleDirect') => {
    const receipts = await run([{ address: invoice, abi: invoiceEscrowAbi, functionName }]);
    if (receipts) {
      refetch();
      refetchBalance();
      void refetchOwed();
    }
  };
  const onWithdraw = async () => {
    if (!account) return;
    const receipts = await run([{ address: invoice, abi: invoiceEscrowAbi, functionName: 'withdraw', args: [account] }]);
    if (receipts) void refetchOwed();
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

      {(history || historyError) && (
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-3">History</h2>
          {history ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-2">
              <Timeline history={history} status={status} account={account} money={money} />
              <PaidViaMesh session={meshSessions?.[0]} />
              {escrowRef && (
                <p className="text-xs text-slate-500 py-2">
                  Each invoice event on-chain carries the reference <span className="font-mono">{decodeRef(escrowRef)}</span>.
                </p>
              )}
              {(history.paid || history.cancelled || history.settledDirect) && (
                <div className="border-t border-slate-700 mt-2 pt-2">
                  <Settlement history={history} principal={inv.principal} dueDate={inv.dueDate} money={money} account={account} />
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              History unavailable.{' '}
              <button onClick={() => void refetchHistory()} className="underline">
                Retry
              </button>
            </p>
          )}
        </section>
      )}

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

      {(actions.payWithMesh || mesh.state.status !== 'idle') && (
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="font-semibold mb-1">Pay with Mesh</h2>
          {(mesh.state.status === 'idle' || mesh.state.status === 'starting') && (
            <>
              <p className="text-sm text-slate-400">Pay from an exchange account or wallet through Mesh. No wallet connection needed.</p>
              {mesh.state.status === 'idle' && mesh.state.note && <p className="text-sm text-amber-300 mt-2">{mesh.state.note}</p>}
              <button
                onClick={() => void mesh.start(invoice)}
                disabled={mesh.state.status === 'starting'}
                className="mt-3 bg-indigo-600 hover:bg-indigo-500 px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {mesh.state.status === 'starting' ? 'Getting a quote…' : 'Pay with Mesh'}
              </button>
            </>
          )}
          {(mesh.state.status === 'quoted' || mesh.state.status === 'linking') && (
            <div className="mt-3 border border-indigo-800 bg-indigo-950 rounded-lg p-4 text-sm">
              <p>
                Pay{' '}
                <span className="font-semibold">
                  {mesh.state.quote.displayAmount} {mesh.state.quote.symbol}
                </span>{' '}
                now ({bpsToPercent(mesh.state.quote.discountBps)} discount) to invoice{' '}
                <span className="font-mono">{decodeRef(inv.invoiceRef)}</span>. Quote valid until{' '}
                {new Date(mesh.state.quote.expiresAt * 1000).toLocaleTimeString()}.
              </p>
              <div className="flex gap-3 mt-3">
                {now < mesh.state.quote.expiresAt ? (
                  <button
                    onClick={() => void mesh.open()}
                    disabled={mesh.state.status === 'linking'}
                    className="bg-indigo-600 hover:bg-indigo-500 px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {mesh.state.status === 'linking' ? 'Mesh is open…' : 'Continue to Mesh'}
                  </button>
                ) : (
                  <button
                    onClick={() => void mesh.start(invoice)}
                    className="bg-indigo-600 hover:bg-indigo-500 px-5 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Quote expired; get a new one
                  </button>
                )}
                <button
                  onClick={mesh.reset}
                  disabled={mesh.state.status === 'linking'}
                  className="bg-slate-700 hover:bg-slate-600 px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  Back
                </button>
              </div>
            </div>
          )}
          {mesh.state.status === 'polling' && <MeshProgress session={mesh.session} onRetry={() => void mesh.start(invoice)} />}
          {mesh.state.status === 'error' && (
            <p className="text-sm text-red-400 mt-3">
              {mesh.state.message}{' '}
              <button onClick={mesh.reset} className="underline">
                Back
              </button>
            </p>
          )}
        </section>
      )}

      {(actions.finishSettlement || actions.acceptAndSettle) && (
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <CutoffWarning cutoff={nextCutoff} />
          {actions.finishSettlement && (
            <div>
              <h2 className="font-semibold mb-1">Finish settlement</h2>
              <p className="text-sm text-slate-400">
                This invoice holds {money(balance)}, which covers the {money(split.toSeller)} due now. Settling forwards it all to{' '}
                {short(inv.payoutAddress)} and closes the invoice. Anyone may do this.
              </p>
              <button
                onClick={() => { resetTx(); void onCall('settleDirect'); }}
                disabled={wrongChain || txState.status === 'pending'}
                className="mt-3 bg-indigo-600 hover:bg-indigo-500 px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                Finish settlement
              </button>
            </div>
          )}
          {actions.acceptAndSettle && (
            <div>
              <h2 className="font-semibold mb-1">Accept and settle</h2>
              <p className="text-sm text-slate-400">
                This invoice holds {money(balance)}, less than the {money(split.toSeller)} due now. You can accept it as payment in full.
              </p>
              {confirmAccept ? (
                <div className="mt-3 border border-amber-800 bg-amber-950 rounded-lg p-4 text-sm">
                  <p>
                    You will receive <span className="font-semibold">{money(balance)}</span> instead of {money(split.toSeller)}, and the invoice
                    closes as Paid.
                  </p>
                  <div className="flex gap-3 mt-3">
                    <button
                      onClick={() => { resetTx(); setConfirmAccept(false); void onCall('settleDirect'); }}
                      disabled={wrongChain || txState.status === 'pending'}
                      className="bg-amber-600 hover:bg-amber-500 px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Accept {money(balance)} and settle
                    </button>
                    <button
                      onClick={() => setConfirmAccept(false)}
                      className="bg-slate-700 hover:bg-slate-600 px-5 py-2 rounded-lg text-sm font-medium transition-colors"
                    >
                      Back
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmAccept(true)}
                  className="mt-3 bg-slate-700 hover:bg-slate-600 px-5 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Accept and settle
                </button>
              )}
            </div>
          )}
          <WriteStatus state={txState} />
        </section>
      )}

      {actions.withdraw && (
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="font-semibold mb-1">Withdraw</h2>
          <p className="text-sm text-slate-400">
            You have {money(owed ?? 0n)} to withdraw from this invoice. A payment to your address couldn’t be sent, so it
            was held here for you.
          </p>
          <button
            onClick={() => { resetTx(); void onWithdraw(); }}
            disabled={wrongChain || txState.status === 'pending'}
            className="mt-3 bg-indigo-600 hover:bg-indigo-500 px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            Withdraw to {account ? short(account) : 'your wallet'}
          </button>
          <WriteStatus state={txState} />
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
              <p className="text-xs text-slate-500 mt-2">
                {fundPath === 'native'
                  ? 'Your wallet sends one transaction carrying the ETH.'
                  : fundPath === 'batch'
                    ? 'Your wallet sends approve and fund together in one atomic batch.'
                    : 'Your wallet asks for two transactions: approve, then fund.'}
              </p>
              <CutoffWarning cutoff={nextCutoff} />
              <button
                onClick={() => { resetFund(); void onFund(); }}
                disabled={wrongChain || !refundValid || fundState.status === 'pending'}
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
                  <CutoffWarning cutoff={nextCutoff} />
                  <button
                    onClick={() => { resetTx(); void onCall('triggerPayment'); }}
                    disabled={wrongChain || txState.status === 'pending'}
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
                    disabled={wrongChain || txState.status === 'pending'}
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
