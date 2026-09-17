/**
 * Keeping a screen current without asking it to poll.
 *
 * Two managers editing the same day could not see each other: every screen
 * loaded once and stayed as it was until somebody navigated away and back. On a
 * shop floor that matters — a person clocks in, and the manager looking at the
 * team list is reading a minute-old answer.
 *
 * Deliberately narrow. This is for what changes during a working day: who is on
 * the floor, whether the shop is open, a correction waiting to be approved.
 * Historical reports and old payroll periods are not subscribed to; a payroll
 * export does not become more correct for arriving a second sooner, and every
 * subscription is traffic on a phone on mall wifi.
 *
 * Only tables in the supabase_realtime publication deliver anything at all.
 *
 * Mirrored byte-for-byte in timekeeper-online and watch-store-crm. See
 * src/shared/README.md before editing.
 */
import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

export interface Watch {
  table: string;
  /** PostgREST filter, e.g. `date_logged=eq.2026-09-17`. */
  filter?: string;
}

export interface LiveOptions {
  /** False unsubscribes — pass `viewing === today` so a past day stays quiet. */
  enabled?: boolean;
  /**
   * A burst of changes is one reload. Clocking a whole shop in at opening would
   * otherwise refetch once per person.
   */
  settleMs?: number;
}

/**
 * Reload when any of these tables changes.
 *
 * `onChange` is held in a ref, so passing a fresh function each render does not
 * tear the subscription down and build it again — which, with a function
 * defined in the component body, would be every render.
 */
export function useLive(
  channelName: string,
  watches: Watch[],
  onChange: () => void,
  opts: LiveOptions = {},
): void {
  const { enabled = true, settleMs = 400 } = opts;
  const latest = useRef(onChange);
  latest.current = onChange;

  // A stable description of what is being watched, so the effect re-runs when
  // the watches genuinely change and not when the array is rebuilt.
  const key = watches.map((w) => `${w.table}:${w.filter ?? ''}`).join('|');

  useEffect(() => {
    if (!enabled || !key) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; latest.current(); }, settleMs);
    };

    let channel = supabase.channel(channelName);
    for (const w of key.split('|')) {
      const [table, filter] = w.split(/:(.*)/s);
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        settle,
      );
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [channelName, key, enabled, settleMs]);
}
