import { format } from 'date-fns';
import { nextCaseId } from '../db';

export async function generateCaseId(): Promise<string> {
  return nextCaseId(format(new Date(), 'yyyy-MM-dd'));
}
