import { useEffect, useState } from 'react';
import { nameSkeleton, type BrandCount } from '../db';

const ARABIC = /[؀-ۿ]/;

/**
 * The brands a typed word could mean. Latin letters match by name ("denn" → Dennison);
 * Arabic letters match by sound, using the database's own rule (دنيسون → Dennison),
 * the same one Ask Mohammed uses. Pass the word's skeleton from useSkeleton().
 */
export function matchBrands(brands: BrandCount[], query: string, skeleton: string | null, limit = 50): BrandCount[] {
  const q = query.trim().toLowerCase();
  if (!q) return brands.slice(0, limit);
  if (ARABIC.test(q)) {
    if (!skeleton || skeleton.length < 2) return [];
    return brands.filter(b => b.skeleton === skeleton || (skeleton.length >= 3 && b.skeleton.startsWith(skeleton))).slice(0, limit);
  }
  return brands.filter(b => b.brand.toLowerCase().includes(q)).slice(0, limit);
}

/** The consonant sounds of an Arabic word, fetched once it has stopped changing; null for Latin text. */
export function useSkeleton(query: string): string | null {
  const [skeleton, setSkeleton] = useState<string | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!ARABIC.test(q)) { setSkeleton(null); return; }
    let live = true;
    const t = window.setTimeout(() => {
      void nameSkeleton(q).then(s => { if (live) setSkeleton(s); }).catch(() => { if (live) setSkeleton(null); });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [query]);
  return skeleton;
}
