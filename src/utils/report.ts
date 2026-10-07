import { caseLabel } from '../shared/caseLabels';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import type { Case } from '../types';
import { formatKD } from './formatKD';
import { getEffectiveItems } from './saleItems';
import type { ReportTill } from '../db';
import { outletName } from '../shared/outlets';
import releases from '../releases.json';

// ── Hourly traffic builder (Google Maps-style popular times) ─────────────────
export function buildHourlyTraffic(cases: Case[]): { hour: number; label: string; count: number }[] {
  const hourCounts: Record<number, number> = {};

  for (const c of cases) {
    const parts = (c.timeLogged || '').split(':');
    const hour = parseInt(parts[0], 10);
    if (isNaN(hour) || hour < 0 || hour > 23) continue;
    // No Interaction uses real visitor_count; every other case counts as 1 interaction
    const add = c.caseType === 'No Interaction' ? (c.visitorCount ?? 1) : 1;
    hourCounts[hour] = (hourCounts[hour] || 0) + add;
  }

  if (Object.keys(hourCounts).length === 0) return [];

  const hours = Object.keys(hourCounts).map(Number);
  const minH = Math.min(...hours);
  const maxH = Math.max(...hours);

  const result: { hour: number; label: string; count: number }[] = [];
  for (let h = minH; h <= maxH; h++) {
    const suffix = h < 12 ? 'am' : 'pm';
    const display = h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h - 12}${suffix}` : `${h}${suffix}`;
    result.push({ hour: h, label: display, count: hourCounts[h] || 0 });
  }
  return result;
}

/** One hour of the day, split by what each visit came to. */
export interface HourMix { hour: number; label: string; sale: number; interested: number; lost: number; browsing: number; total: number }
export function buildHourlyMix(cases: Case[]): HourMix[] {
  const by: Record<number, HourMix> = {};
  for (const c of cases) {
    const hour = parseInt((c.timeLogged || '').split(':')[0], 10);
    if (isNaN(hour) || hour < 0 || hour > 23) continue;
    const m = by[hour] ?? (by[hour] = { hour, label: '', sale: 0, interested: 0, lost: 0, browsing: 0, total: 0 });
    if (c.caseType === 'Sale') m.sale++;
    else if (c.caseType === 'Follow-up') m.interested++;
    else if (c.caseType === 'Lost Sale') m.lost++;
    else m.browsing += c.caseType === 'No Interaction' ? (c.visitorCount ?? 1) : 1;
    m.total = m.sale + m.interested + m.lost + m.browsing;
  }
  const hours = Object.keys(by).map(Number);
  if (!hours.length) return [];
  const out: HourMix[] = [];
  for (let h = Math.min(...hours); h <= Math.max(...hours); h++) {
    const label = h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`;
    out.push({ ...(by[h] ?? { hour: h, sale: 0, interested: 0, lost: 0, browsing: 0, total: 0 }), label });
  }
  return out;
}

type Breakdown = Record<string, { count: number; kd: number }>;

export function buildDailyStats(cases: Case[]) {
  // A sale created by closing an earlier follow-up carries linkedCaseId. It is NOT
  // walk-in trade for this day, so it is kept out of the day's figures and reported
  // in its own Follow-up Conversions log instead.
  const followUpWins = cases.filter(c => c.caseType === 'Sale' && !!c.linkedCaseId);
  const isFollowUpWin = (c: Case) => c.caseType === 'Sale' && !!c.linkedCaseId;
  const dayCases = cases.filter(c => !isFollowUpWin(c));
  const followUpWinRevenue = followUpWins.reduce((s, c) => s + (c.amountKD || 0), 0);

  const sales = dayCases.filter(c => c.caseType === 'Sale');
  const followups = dayCases.filter(c => c.caseType === 'Follow-up');
  const lost = dayCases.filter(c => c.caseType === 'Lost Sale');
  const browsing = dayCases.filter(c => c.caseType === 'No Interaction');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  const staffMap: Record<string, { sales: number; kd: number; followups: number; lost: number }> = {};
  for (const c of dayCases) {
    if (!staffMap[c.staff]) staffMap[c.staff] = { sales: 0, kd: 0, followups: 0, lost: 0 };
    if (c.caseType === 'Sale') { staffMap[c.staff].sales++; staffMap[c.staff].kd += c.amountKD || 0; }
    if (c.caseType === 'Follow-up') staffMap[c.staff].followups++;
    if (c.caseType === 'Lost Sale') staffMap[c.staff].lost++;
  }

  // Brand and product-type revenue are attributed per line item, the same way the
  // manager dashboard does it. Reading case.brand here credited a whole basket to
  // its first item — a watch-plus-strap sale showed as all watch brand, and the
  // strap brand never appeared at all.
  const brandSalesMap: Breakdown = {};
  const typeSalesMap: Breakdown = {};
  const tally = (map: Breakdown, key: string, kd: number) => {
    if (!map[key]) map[key] = { count: 0, kd: 0 };
    map[key].count++;
    map[key].kd += kd;
  };
  for (const c of sales) {
    for (const item of getEffectiveItems(c)) {
      tally(brandSalesMap, item.brand || item.product || 'Unknown', item.amountKD || 0);
      tally(typeSalesMap, item.productType || 'Other', item.amountKD || 0);
    }
  }

  const brandLostMap: Record<string, number> = {};
  for (const c of lost) {
    const brand = c.brand || c.product || 'Unknown';
    brandLostMap[brand] = (brandLostMap[brand] || 0) + 1;
  }

  return {
    sales, followups, lost, browsing, revenue, convRate, staffMap,
    brandSalesMap, typeSalesMap, brandLostMap, dayCases, followUpWins, followUpWinRevenue,
  };
}

export function pdfFileName(date: string, outlet?: string) {
  const outletPart = outlet ? `_${outlet.replace(/\s+/g, '_')}` : '';
  return `TIME_KEEPER_Daily_Report_${date}${outletPart}.pdf`;
}

// ── Page geometry (mm, A4 portrait) ─────────────────────────────────────────
// The report is read on a phone and sent on WhatsApp, so the page is shaped
// like a phone: narrow enough that 8pt type lands around 11px on a handset,
// and exactly as tall as the content. It used to be A4 — a quarter of it blank
// under the last table, and every figure too small to read without zooming.
const PAGE_W = 100;
const ML = 7;
const CONTENT_R = PAGE_W - ML;           // 93
const HEADER_H = 21;
const FOOTER_H = 9;
const CONTENT_TOP = 27;
const BOTTOM_PAD = 5;
// A continuous page still needs a floor and a ceiling: a quiet day should not
// print a stub, and a very long one should not become a single unusable strip.
const MIN_PAGE_H = 150;
const MAX_PAGE_H = 1400;
const MEASURE_H = 4000;
// Smallest table worth starting: head row plus one body row. Only reached on a
// day long enough to have been paginated at MAX_PAGE_H.
const MIN_TABLE_H = 16;

const TEAL: [number, number, number] = [15, 118, 110];
const INK: [number, number, number] = [30, 41, 59];
const MUTED: [number, number, number] = [100, 116, 139];

/* One colour per kind of thing, the same ones the app uses on its tiles (sales green, interested
   amber, lost rose), so a reader who knows the screen reads the report at a glance. Each has a strong
   shade for text and headers and a pale tint for tiles and alternate rows. */
type RGB = [number, number, number];
const HUE = {
  teal:   { fg: TEAL as RGB,            bg: [236, 253, 250] as RGB },
  green:  { fg: [4, 120, 87] as RGB,    bg: [236, 253, 245] as RGB },
  indigo: { fg: [67, 56, 202] as RGB,   bg: [238, 242, 255] as RGB },
  amber:  { fg: [180, 83, 9] as RGB,    bg: [255, 251, 235] as RGB },
  rose:   { fg: [190, 18, 60] as RGB,   bg: [255, 241, 242] as RGB },
  sky:    { fg: [3, 105, 161] as RGB,   bg: [240, 249, 255] as RGB },
  violet: { fg: [109, 40, 217] as RGB,  bg: [245, 243, 255] as RGB },
  slate:  { fg: [51, 65, 85] as RGB,    bg: [248, 250, 252] as RGB },
};
type Hue = keyof typeof HUE;
/** The colour an outcome is drawn in, wherever it appears. */
const OUTCOME_HUE: Record<string, Hue> = { Sale: 'green', 'Lost Sale': 'rose', 'Follow-up': 'amber', 'No Interaction': 'slate' };

function drawHeader(doc: jsPDF, displayDate: string, page: number, outlet?: string) {
  doc.setFillColor(10, 10, 10);
  doc.rect(0, 0, PAGE_W, HEADER_H, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(2.2);
  doc.text('TIME KEEPER', ML, 9);
  doc.setCharSpace(0);
  doc.setFontSize(6);
  doc.setTextColor(170, 170, 170);
  doc.text(page > 1 ? 'DAILY REPORT · CONT.' : 'DAILY REPORT', CONTENT_R, 8, { align: 'right' });

  doc.setCharSpace(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text(displayDate, ML, 16.5);
  if (outlet) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(180, 220, 215);
    doc.text(outlet.toUpperCase(), CONTENT_R, 16.5, { align: 'right' });
  }
  doc.setFillColor(...TEAL);
  doc.rect(0, HEADER_H, PAGE_W, 1.2, 'F');
}

function drawFooter(doc: jsPDF, pageH: number, page: number, pages: number, generatedAt: string) {
  doc.setFillColor(10, 10, 10);
  doc.rect(0, pageH - FOOTER_H, PAGE_W, FOOTER_H, 'F');
  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(1.2);
  doc.setTextColor(170, 170, 170);
  doc.text('TIME KEEPER', ML, pageH - 3.5);
  doc.setCharSpace(0);
  // which build made this report: the first thing to ask when a report looks wrong on somebody's phone
  doc.setTextColor(120, 120, 120);
  const made = `${generatedAt}  ·  v${releases[0].version}`;
  const right = pages > 1 ? `${made}  ·  ${page}/${pages}` : made;
  doc.text(right, CONTENT_R, pageH - 3.5, { align: 'right' });
}

/** Sortable label for a case's time-of-day; entries without one sort last. */
const timeKey = (c: Case) => c.timeLogged || '99:99';
/** Clip long free text; the full text lives in the app. */
const clip = (s: string | undefined, n: number) =>
  !s ? '' : s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';

/**
 * Draw everything between the bars, and say where it ended.
 *
 * Runs twice: once on a page tall enough that nothing can break, to find out
 * how much room the day actually needs, then again on a page cut to that
 * height. That is what makes the report end where the content ends.
 */
function renderBody(doc: jsPDF, pageH: number, date: string, cases: Case[], till: ReportTill | null): number {
  const stats = buildDailyStats(cases);
  const { sales: typedSales, followups, lost, staffMap: typedStaffMap, dayCases, followUpWins, followUpWinRevenue } = stats;
  let { brandSalesMap, typeSalesMap } = stats;

  /* Lightspeed is where the sale was rung up, so when it holds the day's sales they are the
     report's sales: the same figures the tiles and Close Day use. Sales typed into the app are
     then a note-to-self, not a second count. Without Lightspeed's sales (an old day, the sync
     down) the report falls back to the typed ones, as it always did. */
  const saleCount = till ? till.count : typedSales.length;
  const revenueText = till ? (till.revenue == null ? '—' : formatKD(till.revenue)) : formatKD(stats.revenue);
  const convTotal = saleCount + lost.length;
  const convRate = till ? (convTotal > 0 ? Math.round((saleCount / convTotal) * 100) : 0) : stats.convRate;
  const tillTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kuwait' });

  // Staff: sales and KD from the till, the visit counts from what was logged.
  const staffMap: Record<string, { sales: number; kd: number | null; followups: number; lost: number }> = {};
  for (const [name, d] of Object.entries(typedStaffMap)) {
    staffMap[name] = { sales: till ? 0 : d.sales, kd: till ? (till.revenue == null ? null : 0) : d.kd, followups: d.followups, lost: d.lost };
  }
  if (till) {
    for (const p of till.byPerson) {
      if (!staffMap[p.name]) staffMap[p.name] = { sales: 0, kd: 0, followups: 0, lost: 0 };
      staffMap[p.name].sales = p.count;
      staffMap[p.name].kd = till.revenue == null ? null : p.kd;
    }
    // Brands come from the till's own lines, and only the lines that carry a brand.
    brandSalesMap = {}; typeSalesMap = {};
    for (const sale of till.sales ?? []) {
      if (sale.isReturn) continue;
      for (const it of sale.items) {
        if (!it.brand) continue;
        const b = brandSalesMap[it.brand] ?? (brandSalesMap[it.brand] = { count: 0, kd: 0 });
        b.count += it.qty; b.kd += it.kd ?? 0;
      }
    }
  }

  const contentBottom = pageH - FOOTER_H - 3;
  let curY = CONTENT_TOP;

  const ensureSpace = (h: number) => {
    if (curY + h > contentBottom) { doc.addPage(); curY = CONTENT_TOP; }
  };
  /** Section heading, optional note on the line beneath. Returns the table's start y. */
  const heading = (title: string, note?: string, hue: Hue = 'teal') => {
    ensureSpace(4 + MIN_TABLE_H);
    // a short bar in the section's colour, so each section is found by colour as well as by name
    doc.setFillColor(...HUE[hue].fg);
    doc.roundedRect(ML, curY - 3, 1.1, 3.6, 0.5, 0.5, 'F');
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(title, ML + 2.6, curY);
    if (!note) return curY + 2.5;
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    const lines = doc.splitTextToSize(note, CONTENT_R - ML) as string[];
    doc.text(lines, ML, curY + 3.2);
    return curY + 2.5 + lines.length * 2.4;
  };
  const tableEnd = (gap = 6) => { curY = (doc as any).lastAutoTable.finalY + gap; };
  const tableBase = {
    theme: 'striped' as const,
    headStyles: { fillColor: TEAL, fontSize: 7, cellPadding: 1.3 },
    margin: { left: ML, right: ML, top: CONTENT_TOP, bottom: pageH - contentBottom },
    styles: { fontSize: 7.5, cellPadding: 1.3, overflow: 'linebreak' as const },
  };
  /** A table dressed in one colour: its header in the strong shade, every other row in the tint. */
  const tinted = (hue: Hue) => ({
    ...tableBase,
    headStyles: { ...tableBase.headStyles, fillColor: HUE[hue].fg },
    alternateRowStyles: { fillColor: HUE[hue].bg },
  });

  // ── Headline figures: three across, two down ─────────────────────────────
  // With the till, the sales typed in are not visits of their own: each till sale is one visitor.
  const logged = dayCases.reduce((s, c) =>
    s + (c.caseType === 'No Interaction' ? (c.visitorCount ?? 1) : till && c.caseType === 'Sale' ? 0 : 1), 0);
  const totalVisitors = till ? logged + till.count : logged;
  const kpis: { label: string; value: string; hue: Hue }[] = [
    { label: 'Revenue (KD)', value: revenueText, hue: 'teal' },
    { label: 'Sales', value: String(saleCount), hue: 'green' },
    { label: 'Conversion', value: `${convRate}%`, hue: 'indigo' },
    { label: 'Interested', value: String(followups.length), hue: 'amber' },
    { label: 'Lost opp.', value: String(lost.length), hue: 'rose' },
    { label: 'Visitors', value: String(totalVisitors), hue: 'sky' },
  ];
  const kpiCols = 3, kpiGap = 2.5, kpiH = 13;
  const kpiW = (CONTENT_R - ML - kpiGap * (kpiCols - 1)) / kpiCols;
  kpis.forEach((kpi, i) => {
    const x = ML + (i % kpiCols) * (kpiW + kpiGap);
    const y = curY + Math.floor(i / kpiCols) * (kpiH + kpiGap);
    doc.setFillColor(...HUE[kpi.hue].bg);
    doc.roundedRect(x, y, kpiW, kpiH, 1.6, 1.6, 'F');
    doc.setFillColor(...HUE[kpi.hue].fg);
    doc.roundedRect(x + kpiW / 2 - 4, y + 0.9, 8, 0.8, 0.4, 0.4, 'F');
    // Revenue can run to five figures; shrink to fit rather than overflow the tile.
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...HUE[kpi.hue].fg);
    let size = 11;
    doc.setFontSize(size);
    while (doc.getTextWidth(kpi.value) > kpiW - 3 && size > 6) { size -= 0.5; doc.setFontSize(size); }
    doc.text(kpi.value, x + kpiW / 2, y + 6.2, { align: 'center' });
    doc.setFontSize(5.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(kpi.label, x + kpiW / 2, y + 10.4, { align: 'center' });
  });
  curY += Math.ceil(kpis.length / kpiCols) * (kpiH + kpiGap) + 4;

  // ── Sales by shop: only when the report spans shops ──────────────────────
  if (till && till.byOutlet.length > 0) {
    const startY = heading('Sales by outlet', till.channels.some(c => c.sales > 0)
      ? `Not in the shops: ${till.channels.filter(c => c.sales > 0).map(c => `${c.name.replace(/^Time Keeper\s+/i, '')} ${c.sales}${c.revenue == null ? '' : ` · ${formatKD(c.revenue)} KD`}`).join('  ·  ')}`
      : undefined);
    autoTable(doc, {
      ...tinted('teal'), startY,
      head: [['Outlet', 'Sales', 'KD']],
      body: till.byOutlet.map(o => [o.name.replace(/^Time Keeper\s*-\s*/i, ''), String(o.count), o.kd == null ? '—' : formatKD(o.kd)]),
      columnStyles: { 0: { cellWidth: 'auto' }, 1: { cellWidth: 12, halign: 'right' }, 2: { cellWidth: 20, halign: 'right' } },
    });
    tableEnd();
  }

  // ── Store traffic ────────────────────────────────────────────────────────
  // Till sales add to the hour they were rung; the typed copies would count them twice.
  const trafficCases: Case[] = till && till.sales
    ? [...dayCases.filter(c => c.caseType !== 'Sale'),
       ...till.sales.filter(x => !x.isReturn).map(x => ({ caseType: 'Sale', timeLogged: tillTime(x.at) }) as Case)]
    : dayCases;
  const mix = buildHourlyMix(trafficCases);
  if (mix.length > 0) {
    /* Stacked by what each visit came to, so the chart answers "busy with what" as well as
       "how busy": sales at the base where the eye lands, then interested, lost, and browsing on top.
       The four colours pass a colour-blind separation check, and the legend carries each total,
       so colour is never the only key. */
    const SERIES: { key: 'sale' | 'interested' | 'lost' | 'browsing'; label: string; rgb: RGB }[] = [
      { key: 'sale', label: 'Sales', rgb: [4, 120, 87] },
      { key: 'interested', label: 'Interested', rgb: [217, 119, 6] },
      { key: 'lost', label: 'Lost', rgb: [225, 29, 72] },
      { key: 'browsing', label: 'Browsing', rgb: [2, 132, 199] },
    ];
    const chartH = 34, legendH = 6;
    ensureSpace(8 + chartH + legendH + 6);
    const peak = mix.reduce((mx, t) => t.total > mx.total ? t : mx, mix[0]);
    const visitors = mix.reduce((n, t) => n + t.total, 0);

    doc.setFillColor(...HUE.sky.fg);
    doc.roundedRect(ML, curY - 3, 1.1, 3.6, 0.5, 0.5, 'F');
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text('Store Traffic', ML + 2.6, curY);
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(`${visitors} visitor${visitors === 1 ? '' : 's'}  ·  busiest ${peak.label} (${peak.total})`, CONTENT_R, curY, { align: 'right' });

    const boxX = ML, boxY = curY + 3, boxW = CONTENT_R - ML;
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(boxX, boxY, boxW, chartH, 1.8, 1.8, 'F');

    const padX = 2.5, topPad = 5, labelRowH = 5.5;
    const plotX = boxX + padX, plotW = boxW - padX * 2;
    const baseY = boxY + chartH - labelRowH;
    const plotH = baseY - (boxY + topPad);
    const maxTotal = Math.max(...mix.map(t => t.total), 1);
    // a ceiling on a round number, so the gridlines mean something
    const step = maxTotal <= 4 ? 1 : maxTotal <= 10 ? 2 : maxTotal <= 25 ? 5 : 10;
    const ceil = Math.ceil(maxTotal / step) * step;
    const yOf = (v: number) => baseY - (v / ceil) * plotH;

    // recessive gridlines, their values at the left edge
    doc.setLineWidth(0.12);
    doc.setDrawColor(226, 232, 240);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(4.4);
    doc.setTextColor(148, 163, 184);
    for (let v = step; v <= ceil; v += step) {
      const gy = yOf(v);
      doc.line(plotX + 3, gy, plotX + plotW, gy);
      doc.text(String(v), plotX + 1.8, gy + 0.6, { align: 'right' });
    }
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.2);
    doc.line(plotX + 3, baseY, plotX + plotW, baseY);

    const slotX0 = plotX + 3, slotW = (plotW - 3) / mix.length;
    const barW = Math.min(slotW * 0.62, 7.5);
    const gap = 0.35;                         // a thin surface gap between stacked segments
    const everyLabel = mix.length <= 12;
    mix.forEach((t, i) => {
      const cx = slotX0 + i * slotW + slotW / 2;
      const x = cx - barW / 2;
      const isPeak = t === peak && t.total > 0;
      if (t.total === 0) {
        doc.setFillColor(226, 232, 240);
        doc.roundedRect(x, baseY - 0.8, barW, 0.8, 0.3, 0.3, 'F');
      } else {
        let y = baseY;
        const parts = SERIES.filter(sr => t[sr.key] > 0);
        parts.forEach((sr, k) => {
          const h = (t[sr.key] / ceil) * plotH;
          const top = k === parts.length - 1;
          const segH = Math.max(h - (top ? 0 : gap), 0.4);
          doc.setFillColor(...sr.rgb);
          if (top) {
            // a rounded data end at the top, square where it meets the segment below
            const r = Math.min(0.9, segH / 2, barW / 2);
            doc.roundedRect(x, y - segH, barW, segH, r, r, 'F');
            doc.rect(x, y - Math.min(segH, r), barW, Math.min(segH, r), 'F');
          } else {
            doc.rect(x, y - segH, barW, segH, 'F');
          }
          y -= h;
        });
        doc.setFont('helvetica', isPeak ? 'bold' : 'normal');
        doc.setFontSize(isPeak ? 5.6 : 5);
        doc.setTextColor(...(isPeak ? INK : MUTED));
        doc.text(String(t.total), cx, yOf(t.total) - 1, { align: 'center' });
      }
      if (everyLabel || i % 2 === 0 || isPeak) {
        doc.setFont('helvetica', isPeak ? 'bold' : 'normal');
        doc.setFontSize(4.6);
        doc.setTextColor(...(isPeak ? INK : MUTED));
        doc.text(t.label, cx, baseY + 3.6, { align: 'center' });
      }
    });

    // the legend: each outcome present, with its day total
    const totals = SERIES.map(sr => ({ ...sr, n: mix.reduce((a, t) => a + t[sr.key], 0) })).filter(sr => sr.n > 0);
    let lx = ML + 0.5;
    const ly = boxY + chartH + 3.6;
    doc.setFontSize(5.6);
    doc.setFont('helvetica', 'normal');
    totals.forEach((sr) => {
      doc.setFillColor(...sr.rgb);
      doc.roundedRect(lx, ly - 2.1, 2.4, 2.4, 0.5, 0.5, 'F');
      doc.setTextColor(...INK);
      const txt = `${sr.label} ${sr.n}`;
      doc.text(txt, lx + 3.3, ly - 0.2);
      lx += 3.3 + doc.getTextWidth(txt) + 4;
    });
    curY = boxY + chartH + legendH + 5;
  }

  // ── Staff ────────────────────────────────────────────────────────────────
  {
    const startY = heading('Staff', undefined, 'indigo');
    const rows = Object.entries(staffMap)
      .sort(([, a], [, b]) => (b.kd ?? 0) - (a.kd ?? 0) || b.sales - a.sales)
      .map(([name, d]) => [name, String(d.sales), d.kd == null ? '—' : formatKD(d.kd), String(d.followups), String(d.lost)]);
    autoTable(doc, {
      ...tinted('indigo'), startY,
      head: [['Staff', 'Sales', 'KD', 'Int.', 'Lost']],
      body: rows.length ? rows : [['—', '0', '0.000', '0', '0']],
      columnStyles: {
        0: { cellWidth: 'auto' }, 1: { cellWidth: 10, halign: 'right' },
        2: { cellWidth: 17, halign: 'right' }, 3: { cellWidth: 9, halign: 'right' },
        4: { cellWidth: 9, halign: 'right' },
      },
      didParseCell: (d: any) => {
        if (d.section !== 'body' || d.cell.raw === '0' || d.cell.raw === '—') return;
        const hue: Hue | null = d.column.index === 1 || d.column.index === 2 ? 'green' : d.column.index === 3 ? 'amber' : d.column.index === 4 ? 'rose' : null;
        if (hue) { d.cell.styles.textColor = HUE[hue].fg; d.cell.styles.fontStyle = 'bold'; }
      },
    });
    tableEnd();
  }

  // ── Brands, then product types: stacked, never side by side ──────────────
  const rowsOf = (m: Breakdown) => Object.entries(m)
    .map(([k, s]) => ({ k, ...s }))
    .sort((a, b) => b.kd - a.kd || b.count - a.count)
    .map(({ k, count, kd }) => [k, String(count), till && till.revenue == null ? '—' : formatKD(kd)]);
  const breakdownCols = {
    0: { cellWidth: 'auto' as const },
    1: { cellWidth: 12, halign: 'right' as const },
    2: { cellWidth: 20, halign: 'right' as const },
  };
  const brandRows = rowsOf(brandSalesMap);
  if (brandRows.length) {
    const startY = heading('Brands sold', till
      ? 'from Lightspeed lines that carry a brand — lines without one are in the sales log'
      : 'per item — a basket counts under each of its brands', 'violet');
    autoTable(doc, { ...tinted('violet'), startY, head: [['Brand', 'Items', 'KD']], body: brandRows, columnStyles: breakdownCols });
    tableEnd();
  }
  const typeRows = rowsOf(typeSalesMap);
  if (typeRows.length) {
    const startY = heading('Product types', undefined, 'violet');
    autoTable(doc, { ...tinted('violet'), startY, head: [['Type', 'Items', 'KD']], body: typeRows, columnStyles: breakdownCols });
    tableEnd();
  }

  // ── Follow-ups closed today, kept out of the day's figures ───────────────
  if (followUpWins.length > 0) {
    const startY = heading('Follow-ups won',
      `${followUpWins.length} closed today · ${formatKD(followUpWinRevenue)} KD — from earlier visits, not counted above`, 'amber');
    autoTable(doc, {
      ...tinted('amber'), startY,
      head: [['Time', 'Customer / item', 'KD']],
      body: [...followUpWins].sort((a, b) => timeKey(a).localeCompare(timeKey(b))).map(c => [
        c.timeLogged || '—',
        [c.customerName, `${c.brand || c.product || '—'}${c.linkedCaseId ? ` (from ${c.linkedCaseId})` : ''}`, c.staff].filter(Boolean).join('\n'),
        formatKD(c.amountKD || 0),
      ]),
      columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 17, halign: 'right' } },
    });
    tableEnd();
  }

  // ── The till's sales, one by one ─────────────────────────────────────────
  if (till && till.sales && till.sales.length > 0) {
    const startY = heading('Sales from Lightspeed',
      `${till.count} counted · ${till.asOf ? `read at ${tillTime(till.asOf)}` : 'time of last read unknown'}`, 'green');
    autoTable(doc, {
      ...tinted('green'), startY,
      head: [['Time', 'Sold by / outlet', 'Items', 'KD']],
      body: [...till.sales].sort((a, b) => a.at.localeCompare(b.at)).map(x => [
        tillTime(x.at),
        [x.soldBy ?? '—', till.byOutlet.length > 0 && x.scope ? outletName(x.scope).replace(/^Time Keeper\s*-\s*/i, '') : undefined].filter(Boolean).join('\n'),
        x.isReturn ? 'Return' : (x.items.map(i => `${i.qty !== 1 ? `${i.qty} × ` : ''}${i.name ?? 'Item'}`).join('; ') || '—').slice(0, 120),
        x.kd == null ? '—' : formatKD(x.kd),
      ]),
      styles: { ...tableBase.styles, fontSize: 6.8, cellPadding: 1.1 },
      headStyles: { ...tableBase.headStyles, fillColor: HUE.green.fg, fontSize: 6.3 },
      columnStyles: { 0: { cellWidth: 9 }, 1: { cellWidth: 22 }, 2: { cellWidth: 'auto' }, 3: { cellWidth: 14, halign: 'right', fontStyle: 'bold', textColor: HUE.green.fg } },
    });
    tableEnd();
  }

  // ── Every visit ──────────────────────────────────────────────────────────
  // A browsing visit with nothing written about it is footfall, already in the
  // count and the chart above; printing it would be a row of dashes. Customer
  // and note sit under the item rather than in columns of their own — at this
  // width six columns leave no room for the words that matter.
  {
    const listed = dayCases.filter(c => c.caseType !== 'No Interaction' || !!c.notes);
    const skipped = dayCases.length - listed.length;
    const startY = heading('Every visit', skipped
      ? `${skipped} browsing visit${skipped === 1 ? '' : 's'} with no note counted in traffic above, not listed`
      : undefined, 'slate');
    const sorted = [...listed].sort((a, b) => timeKey(a).localeCompare(timeKey(b)));
    const rows = sorted
      .map(c => {
        const items = getEffectiveItems(c);
        let item: string;
        if (items.length > 1) item = `${items[0].brand || items[0].product || '—'} +${items.length - 1} more`;
        else if (c.caseType === 'Lost Sale' && c.product && c.product !== c.brand) item = [c.brand, c.product].filter(Boolean).join(' — ');
        else item = c.brand || c.product || '—';
        const typedCopy = !!till && c.caseType === 'Sale';
        const detail = [
          item,
          typedCopy ? `Typed in the app: ${c.amountKD ? formatKD(c.amountKD) : '—'} KD (the till's sale is counted above)` : undefined,
          c.customerName || undefined,
          c.lostReason ? `Reason: ${c.lostReason}` : undefined,
          clip(c.notes, 90) || undefined,
        ].filter(Boolean).join('\n');
        return [c.timeLogged || '—', `${c.staff}\n${caseLabel(c.caseType)}`, detail, c.amountKD && !typedCopy ? formatKD(c.amountKD) : '—'];
      });
    autoTable(doc, {
      ...tinted('slate'), startY,
      head: [['Time', 'Staff / outcome', 'Item / customer / note', 'KD']],
      // the outcome in its colour: green sale, amber interested, rose lost, grey browsing
      didParseCell: (d: any) => {
        if (d.section !== 'body' || d.column.index !== 1 || !sorted[d.row.index]) return;
        d.cell.styles.textColor = HUE[OUTCOME_HUE[sorted[d.row.index].caseType] ?? 'slate'].fg;
        d.cell.styles.fontStyle = 'bold';
      },
      body: rows.length ? rows : [['—', '—', 'Nothing logged', '—']],
      styles: { ...tableBase.styles, fontSize: 6.8, cellPadding: 1.1 },
      headStyles: { ...tableBase.headStyles, fillColor: HUE.slate.fg, fontSize: 6.3 },
      columnStyles: {
        0: { cellWidth: 9 }, 1: { cellWidth: 20 },
        2: { cellWidth: 'auto' }, 3: { cellWidth: 13, halign: 'right' },
      },
    });
    curY = (doc as any).lastAutoTable.finalY;
  }

  return curY;
}

export function generatePDF(date: string, cases: Case[], outlet?: string, till: ReportTill | null = null): string {
  const displayDate = format(new Date(date + 'T12:00:00'), 'd MMMM yyyy');
  // Store time, whatever the device is set to — this is a business record.
  const generatedAt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace(',', '');

  const build = (pageH: number) => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [PAGE_W, pageH] });
    const endY = renderBody(doc, pageH, date, cases, till);
    return { doc, endY };
  };

  // Measure on a page nothing can overflow, then cut the page to what was used.
  const measured = build(MEASURE_H).endY;
  const pageH = Math.min(MAX_PAGE_H, Math.max(MIN_PAGE_H, Math.ceil(measured + FOOTER_H + BOTTOM_PAD)));

  const { doc } = build(pageH);
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    drawHeader(doc, displayDate, p, outlet);
    drawFooter(doc, pageH, p, pages, generatedAt);
  }
  return doc.output('datauristring');
}

export function downloadReport(date: string, pdfUri: string, outlet?: string) {
  const link = document.createElement('a');
  link.href = pdfUri;
  link.download = pdfFileName(date, outlet);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function shareReport(
  date: string, pdfUri: string, outlet?: string,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const fileName = pdfFileName(date, outlet);
  const title = `Daily Store Report — ${date}${outlet ? ` · ${outlet}` : ''}`;

  if (navigator.share) {
    try {
      const res = await fetch(pdfUri);
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: 'application/pdf' });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title, text: title, files: [file] });
        return 'shared';
      }
      // this device can't attach files (e.g. desktop) — give them the PDF instead
      downloadReport(date, pdfUri, outlet);
      return 'downloaded';
    } catch (err) {
      // the user dismissed the share sheet — don't force a download on them
      if ((err as { name?: string })?.name === 'AbortError') return 'cancelled';
      // anything else: fall through and still hand over the file
    }
  }

  downloadReport(date, pdfUri, outlet);
  return 'downloaded';
}
