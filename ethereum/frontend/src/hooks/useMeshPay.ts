import type { LinkHandle } from '@meshpayhq/link-web-sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { MESH_SERVER_URL } from '../config';
import { isFinalMeshState, type MeshSessionStart, type SessionView } from '../lib/meshSession';

export type MeshPayState =
  /** `note` explains why a previous attempt ended (e.g. abandoned). */
  | { status: 'idle'; note?: string }
  | { status: 'starting' }
  /** Quote received; waiting for the buyer to confirm and open Mesh Link. */
  | { status: 'quoted'; invoice: Address; quote: MeshSessionStart }
  /** Mesh Link is open. */
  | { status: 'linking'; invoice: Address; quote: MeshSessionStart }
  /** Link closed (`onExit`, paid or not); the session is polled until it is final or abandoned. */
  | { status: 'polling'; invoice: Address; quote: MeshSessionStart }
  | { status: 'error'; message: string };

/** GET/POST against mesh-server; a non-2xx response throws with the server's `error` message. */
async function meshFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${MESH_SERVER_URL}${path}`, init);
  } catch {
    throw new Error('Could not reach the Mesh payment server.');
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(body?.error ? String(body.error) : `Mesh payment server error (${res.status}).`);
  return body as T;
}

/**
 * Pay with Mesh (Mesh spec §5): `start` asks mesh-server for a quote and Link token, `open` opens Mesh Link with it.
 * Link has no success callback, so on `onExit` (paid or not) the session is polled every 5 s until `isFinalMeshState`;
 * a session still `awaiting-transfer` after its `expiresAt` counts as abandoned (back to idle with a note). `onError`
 * (Link didn't start) is an error state. `onChange` runs on every session state change (the page refetches the
 * invoice, its balance and history). The Link callbacks drive the UI only.
 */
export function useMeshPay(onChange: () => void) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<MeshPayState>({ status: 'idle' });
  const handle = useRef<LinkHandle | undefined>(undefined);

  useEffect(() => () => handle.current?.close(), []);

  const start = useCallback(async (invoice: Address) => {
    setState({ status: 'starting' });
    try {
      const quote = await meshFetch<MeshSessionStart>(`/invoices/${invoice}/mesh-session`, { method: 'POST' });
      setState({ status: 'quoted', invoice, quote });
    } catch (e) {
      setState({ status: 'error', message: (e as Error).message });
    }
  }, []);

  const open = useCallback(async () => {
    if (state.status !== 'quoted') return;
    const { invoice, quote } = state;
    setState({ status: 'linking', invoice, quote });
    // Loaded here, not at the top, so nothing from Mesh loads unless the buyer continues to Mesh.
    let openLink: typeof import('@meshpayhq/link-web-sdk').openLink;
    try {
      ({ openLink } = await import('@meshpayhq/link-web-sdk'));
    } catch {
      setState({ status: 'error', message: 'Could not load Mesh Link.' });
      return;
    }
    handle.current = openLink(quote.linkToken, quote.clientId, {
      environment: quote.linkEnvironment,
      target: { mode: 'modal' },
      onExit: () => {
        handle.current = undefined;
        setState({ status: 'polling', invoice, quote });
      },
      onError: (error) => {
        handle.current = undefined;
        setState({ status: 'error', message: `Mesh Link did not start (${error.code}): ${error.message}` });
      },
    });
  }, [state]);

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  const polled = state.status === 'polling' ? state : undefined;
  const { data: session } = useQuery({
    queryKey: ['mesh-session', polled?.invoice, polled?.quote.id],
    enabled: polled !== undefined,
    queryFn: async () => {
      const s = await meshFetch<SessionView>(`/invoices/${polled!.invoice}/mesh-session/${polled!.quote.id}`);
      if (s.state === 'awaiting-transfer' && Date.now() / 1000 > s.expiresAt) {
        setState({ status: 'idle', note: 'No payment arrived before the quote expired.' });
      }
      return s;
    },
    refetchInterval: (query) => (query.state.data && isFinalMeshState(query.state.data.state) ? false : 5_000),
  });
  const sessionState = polled ? session?.state : undefined;

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    if (sessionState === undefined) return;
    onChangeRef.current();
    void queryClient.invalidateQueries({ queryKey: ['mesh-sessions'] });
  }, [sessionState, queryClient]);

  return { state, session: polled ? session : undefined, start, open, reset };
}

/** The invoice's sessions on mesh-server, most recent first, for the "Paid via Mesh" line. No request when `enabled` is false. */
export function useMeshSessions(invoice: Address, enabled: boolean) {
  return useQuery({
    queryKey: ['mesh-sessions', invoice],
    enabled: enabled && MESH_SERVER_URL !== undefined,
    queryFn: async () => (await meshFetch<{ sessions: SessionView[] }>(`/invoices/${invoice}/mesh-sessions`)).sessions,
  });
}
