import { format } from 'date-fns';
import { db } from '../db';

export async function generateCaseId(): Promise<string> {
  const today = format(new Date(), 'yyyy-MM-dd');
  const prefix = today.replace(/-/g, '');
  const existing = await db.cases.where('dateLogged').equals(today).count();
  const seq = (existing + 1).toString().padStart(3, '0');
  return `${prefix}-${seq}`;
}
