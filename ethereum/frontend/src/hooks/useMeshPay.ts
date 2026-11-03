import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { MESH_SERVER_URL } from '../config';
import { isFinalMeshState, type MeshSessionStart, type SessionView } from '../lib/meshSession';

export type MeshPayState =
  | { status: 'idle' }
  | { status: 'starting' }
  /** Quote received; waiting for the buyer to confirm and open Mesh Link. */
  | { status: 'quoted'; invoice: Address; quote: MeshSessionStart }
  /** Mesh Link is open. */
  | { status: 'linking'; invoice: Address; quote: MeshSessionStart }
  /** `onTransferFinished` fired; the session is polled until it is final. */
  | { status: 'submitted'; invoice: Address; quote: MeshSessionStart }
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
 * Pay with Mesh (Mesh spec §5): `start` asks mesh-server for a quote and Link Token, `open` opens Mesh Link with it,
 * and after `onTransferFinished` the session is polled every 5 s until `isFinalMeshState`. `onChange` runs on every
 * session state change (the page refetches the invoice, its balance and history). The Link callbacks drive the UI only.
 */
export function useMeshPay(onChange: () => void) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<MeshPayState>({ status: 'idle' });
  const transferFinished = useRef(false);

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
    transferFinished.current = false;
    setState({ status: 'linking', invoice, quote });
    // Imported here, not at the top: importing the SDK adds a Mesh prewarm iframe to the page.
    let createLink: typeof import('@meshconnect/web-link-sdk').createLink;
    try {
      ({ createLink } = await import('@meshconnect/web-link-sdk'));
    } catch {
      setState({ status: 'error', message: 'Could not load Mesh Link.' });
      return;
    }
    const link = createLink({
      onTransferFinished: () => {
        transferFinished.current = true;
        setState({ status: 'submitted', invoice, quote });
      },
      onExit: () => {
        if (!transferFinished.current) setState({ status: 'idle' });
      },
    });
    link.openLink(quote.linkToken);
  }, [state]);

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  const polled = state.status === 'submitted' ? state : undefined;
  const { data: session } = useQuery({
    queryKey: ['mesh-session', polled?.invoice, polled?.quote.id],
    enabled: polled !== undefined,
    queryFn: () => meshFetch<SessionView>(`/invoices/${polled!.invoice}/mesh-session/${polled!.quote.id}`),
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
