import type { ChannelSales } from '../db';
import { formatKD } from './formatKD';

/** "Online 1 sale · 298 KD" — one channel in a line, for the people allowed to see takings. */
export function channelLine(c: ChannelSales): string {
  const n = `${c.sales} ${c.sales === 1 ? 'sale' : 'sales'}`;
  return c.revenue == null ? `${c.name} ${n}` : `${c.name} ${n} · ${formatKD(c.revenue)} KD`;
}

/** Only the channels that actually sold something in the period. */
export function activeChannels(channels: ChannelSales[] | undefined): ChannelSales[] {
  return (channels ?? []).filter((c) => c.sales > 0);
}
