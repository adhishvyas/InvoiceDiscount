import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { encodeFunctionData, erc20Abi, parseEventLogs, zeroAddress, type Address } from 'viem';
import { useAccount, usePublicClient, useReadContract } from 'wagmi';
import { invoiceFactoryAbi } from '../abi/InvoiceFactory';
import { DEFAULT_TOKEN, FACTORY_ADDRESS, FACTORY_DEPLOY_BLOCK, TOKENS } from '../config';
import { useInvoiceWrite } from '../hooks/useInvoiceWrite';
import { findExistingInvoice } from '../lib/logs';
import { REF_MAX_BYTES, encodeRef, refByteLength } from '../lib/ref';
import { toUnits } from '../lib/units';
import { MAX_TIERS, percentToBps, validateInvoiceForm } from '../lib/validation';

interface TierRow {
  cutoff: string; // datetime-local value
  discountPercent: string;
}

const toUnix = (local: string): number | null => {
  if (!local) return null;
  const ms = new Date(local).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

const inputClass =
  'w-full bg-slate-800 border border-slate-700 text-white text-sm px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-500';

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm text-slate-300 mb-1.5">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-slate-500 mt-1">{hint}</span>}
      {error && <span className="block text-xs text-red-400 mt-1">{error}</span>}
    </label>
  );
}

export default function CreateInvoice() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { state, run, reset } = useInvoiceWrite();

  const [invoiceRef, setInvoiceRef] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState<Address>(DEFAULT_TOKEN.address);
  const [dueDate, setDueDate] = useState('');
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [payout, setPayout] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [dup, setDup] = useState<{ key: string; invoice?: Address; error?: string }>();
  const [created, setCreated] = useState<Address>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(timer);
  }, []);

  const { data: tokenDecimals } = useReadContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
  const decimals = tokenDecimals ?? 6;

  const { valid, errors } = useMemo(
    () =>
      validateInvoiceForm(
        {
          invoiceRef,
          amount,
          token,
          decimals,
          dueDate: toUnix(dueDate),
          tiers: tiers.map((t) => ({ cutoff: toUnix(t.cutoff), discountPercent: t.discountPercent })),
          payoutAddress: payout,
        },
        now,
      ),
    [invoiceRef, amount, token, decimals, dueDate, tiers, payout, now],
  );

  const refBytes = refByteLength(invoiceRef);
  const refUsable = refBytes > 0 && refBytes <= REF_MAX_BYTES;
  const canCheck = Boolean(client && address && FACTORY_ADDRESS && FACTORY_DEPLOY_BLOCK !== undefined);
  const dupKey = `${address}:${invoiceRef.trim()}`;
  const duplicate = dup?.key === dupKey ? dup.invoice : undefined;
  const checkError = dup?.key === dupKey ? dup.error : undefined;

  const checkDuplicate = (): Promise<Address | undefined> =>
    findExistingInvoice(client!, FACTORY_ADDRESS!, FACTORY_DEPLOY_BLOCK!, address!, encodeRef(invoiceRef));

  // Debounced duplicate check on input; the result is keyed so a stale answer is never shown for new input.
  useEffect(() => {
    if (!refUsable || !canCheck) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      findExistingInvoice(client!, FACTORY_ADDRESS!, FACTORY_DEPLOY_BLOCK!, address!, encodeRef(invoiceRef))
        .then((invoice) => !cancelled && setDup({ key: dupKey, invoice }))
        .catch((e: Error) => !cancelled && setDup({ key: dupKey, error: e.message }));
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, address, invoiceRef, refUsable, canCheck, dupKey]);

  const updateTier = (i: number, patch: Partial<TierRow>) =>
    setTiers((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async () => {
    if (!canCheck || !address || !FACTORY_ADDRESS || !valid) return;
    // Check again right before sending: another tab or wallet may have used the reference since typing.
    try {
      const existing = await checkDuplicate();
      if (existing) {
        setDup({ key: dupKey, invoice: existing });
        return;
      }
    } catch (e) {
      setDup({ key: dupKey, error: (e as Error).message });
      return;
    }

    const data = encodeFunctionData({
      abi: invoiceFactoryAbi,
      functionName: 'createInvoice',
      args: [
        encodeRef(invoiceRef),
        token,
        toUnits(amount.trim(), decimals),
        BigInt(toUnix(dueDate)!),
        tiers.map((t) => ({ cutoff: BigInt(toUnix(t.cutoff)!), discountBps: percentToBps(t.discountPercent)! })),
        (payout.trim() || zeroAddress) as Address,
      ],
    });
    const receipts = await run([{ to: FACTORY_ADDRESS, data }]);
    const logs = receipts?.flatMap((r) => parseEventLogs({ abi: invoiceFactoryAbi, logs: r.logs, eventName: 'InvoiceCreated' }));
    if (logs?.[0]) setCreated(logs[0].args.invoice);
  };

  if (created) {
    return (
      <main className="max-w-xl mx-auto px-6 py-16">
        <h1 className="text-2xl font-bold tracking-tight mb-2">Invoice created</h1>
        <p className="text-slate-400 mb-6">
          Share this address with the buyer. Reference: <span className="text-white font-medium">{invoiceRef.trim()}</span>
        </p>
        <p className="font-mono text-sm break-all bg-slate-900 border border-slate-800 rounded-lg p-4 mb-6">{created}</p>
        <div className="flex gap-3">
          <button
            onClick={() => navigator.clipboard.writeText(created).then(() => setCopied(true))}
            className="bg-slate-700 hover:bg-slate-600 text-sm px-4 py-2 rounded-lg transition-colors"
          >
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <Link
            to={`/invoice/${created}`}
            className="bg-indigo-600 hover:bg-indigo-500 text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Open invoice
          </Link>
        </div>
      </main>
    );
  }

  const pending = state.status === 'pending';

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <h1 className="text-2xl font-bold tracking-tight mb-8">Create invoice</h1>

      {!FACTORY_ADDRESS && (
        <p className="text-sm text-amber-300 bg-amber-950 border border-amber-800 rounded-lg p-3 mb-6">
          No factory configured. Set VITE_FACTORY_ADDRESS and VITE_FACTORY_DEPLOY_BLOCK in .env.
        </p>
      )}

      <div className="space-y-5">
        <Field
          label="Invoice reference"
          error={errors.invoiceRef}
          hint={`${refBytes}/${REF_MAX_BYTES} bytes. Also recorded as the memo on every payment.`}
        >
          <input
            value={invoiceRef}
            onChange={(e) => setInvoiceRef(e.target.value)}
            placeholder="INV-2026-0042"
            className={inputClass}
          />
        </Field>
        {duplicate && (
          <p className="text-sm text-red-400 -mt-3">
            You already have an invoice with this reference.{' '}
            <Link to={`/invoice/${duplicate}`} className="underline">
              View it
            </Link>
          </p>
        )}
        {checkError && <p className="text-xs text-amber-300 -mt-3">Could not check for duplicates: {checkError}</p>}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount" error={errors.amount}>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100000" inputMode="decimal" className={inputClass} />
          </Field>
          <Field label="Token" error={errors.token}>
            <select value={token} onChange={(e) => setToken(e.target.value as Address)} className={inputClass}>
              {TOKENS.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Due date" error={errors.dueDate}>
          <input type="datetime-local" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
        </Field>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm text-slate-300">Early-payment discounts</span>
            <button
              onClick={() => setTiers((rows) => [...rows, { cutoff: '', discountPercent: '' }])}
              disabled={tiers.length >= MAX_TIERS}
              className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40"
            >
              + Add tier
            </button>
          </div>
          <p className="text-xs text-slate-500 mb-3">
            Paying before a cutoff earns that discount. Cutoffs must be ascending and no later than the due date.
          </p>
          {errors.tiers && <p className="text-xs text-red-400 mb-2">{errors.tiers}</p>}
          <div className="space-y-3">
            {tiers.map((t, i) => (
              <div key={i} className="flex gap-2 items-start">
                <div className="flex-1">
                  <input
                    type="datetime-local"
                    value={t.cutoff}
                    onChange={(e) => updateTier(i, { cutoff: e.target.value })}
                    aria-label={`Tier ${i + 1} cutoff`}
                    className={inputClass}
                  />
                  {errors.tierRows[i]?.cutoff && <span className="block text-xs text-red-400 mt-1">{errors.tierRows[i].cutoff}</span>}
                </div>
                <div className="w-28">
                  <div className="flex items-center gap-1">
                    <input
                      value={t.discountPercent}
                      onChange={(e) => updateTier(i, { discountPercent: e.target.value })}
                      placeholder="15"
                      inputMode="decimal"
                      aria-label={`Tier ${i + 1} discount percent`}
                      className={inputClass}
                    />
                    <span className="text-slate-400 text-sm">%</span>
                  </div>
                  {errors.tierRows[i]?.discount && <span className="block text-xs text-red-400 mt-1">{errors.tierRows[i].discount}</span>}
                </div>
                <button
                  onClick={() => setTiers((rows) => rows.filter((_, j) => j !== i))}
                  aria-label={`Remove tier ${i + 1}`}
                  className="text-slate-500 hover:text-red-400 px-2 py-2"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        <Field label="Payout address (optional)" error={errors.payoutAddress} hint="Leave empty to be paid at your connected wallet.">
          <input value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="Your connected wallet" className={`${inputClass} font-mono`} />
        </Field>
      </div>

      <button
        onClick={submit}
        disabled={!canCheck || !valid || Boolean(duplicate) || pending}
        className="mt-8 w-full bg-indigo-600 hover:bg-indigo-500 font-medium px-6 py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? 'Creating…' : address ? 'Create invoice' : 'Connect a wallet to create'}
      </button>
      {state.status === 'error' && (
        <p className="text-sm text-red-400 mt-3">
          {state.message}{' '}
          <button onClick={reset} className="underline">
            Dismiss
          </button>
        </p>
      )}
    </main>
  );
}
