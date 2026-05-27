import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import type { Case } from '../types';
import { formatKD } from './formatKD';

export function buildDailyStats(cases: Case[]) {
  const sales = cases.filter(c => c.caseType === 'Sale');
  const followups = cases.filter(c => c.caseType === 'Follow-up');
  const lost = cases.filter(c => c.caseType === 'Lost Sale');
  const browsing = cases.filter(c => c.caseType === 'No Interaction');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  const staffMap: Record<string, { sales: number; kd: number; followups: number; lost: number }> = {};
  for (const c of cases) {
    if (!staffMap[c.staff]) staffMap[c.staff] = { sales: 0, kd: 0, followups: 0, lost: 0 };
    if (c.caseType === 'Sale') { staffMap[c.staff].sales++; staffMap[c.staff].kd += c.amountKD || 0; }
    if (c.caseType === 'Follow-up') staffMap[c.staff].followups++;
    if (c.caseType === 'Lost Sale') staffMap[c.staff].lost++;
  }

  const brandSalesMap: Record<string, { count: number; kd: number }> = {};
  for (const c of sales) {
    const brand = c.brand || c.product || 'Unknown';
    if (!brandSalesMap[brand]) brandSalesMap[brand] = { count: 0, kd: 0 };
    brandSalesMap[brand].count++;
    brandSalesMap[brand].kd += c.amountKD || 0;
  }

  const brandLostMap: Record<string, number> = {};
  for (const c of lost) {
    const brand = c.brand || c.product || 'Unknown';
    brandLostMap[brand] = (brandLostMap[brand] || 0) + 1;
  }

  return { sales, followups, lost, browsing, revenue, convRate, staffMap, brandSalesMap, brandLostMap };
}

export function pdfFileName(date: string) {
  return `TIME_KEEPER_Daily_Report_${date}.pdf`;
}

export function generatePDF(date: string, cases: Case[]): string {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const { sales, followups, lost, browsing, revenue, convRate, staffMap, brandSalesMap, brandLostMap } =
    buildDailyStats(cases);
  const displayDate = format(new Date(date + 'T12:00:00'), 'd MMMM yyyy');

  // ── Header bar ──────────────────────────────────────────────────────────────
  doc.setFillColor(10, 10, 10);
  doc.rect(0, 0, 210, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(3);
  doc.text('TIME KEEPER', 14, 11);
  doc.setFontSize(7);
  doc.setCharSpace(2);
  doc.setTextColor(180, 180, 180);
  doc.text('EST. 2018', 14, 17);
  doc.setCharSpace(1);
  doc.setFontSize(8);
  doc.setTextColor(200, 200, 200);
  doc.text('DAILY REPORT', 196, 11, { align: 'right' });
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setCharSpace(0);
  doc.text(displayDate, 196, 20, { align: 'right' });
  doc.setFillColor(15, 118, 110);
  doc.rect(0, 28, 210, 1.5, 'F');

  // ── KPI tiles (2 rows × 3) ───────────────────────────────────────────────
  const kpis = [
    { label: 'Revenue (KD)', value: formatKD(revenue) },
    { label: 'Sales', value: String(sales.length) },
    { label: 'Follow-ups', value: String(followups.length) },
    { label: 'Lost Sales', value: String(lost.length) },
    { label: 'Browsing', value: String(browsing.length) },
    { label: 'Conversion', value: `${convRate}%` },
  ];
  const kpiW = 58, kpiH = 18, kpiGap = 3, kpiX0 = 14, kpiY0 = 36;
  kpis.forEach((kpi, i) => {
    const x = kpiX0 + (i % 3) * (kpiW + kpiGap);
    const y = kpiY0 + Math.floor(i / 3) * (kpiH + kpiGap);
    doc.setFillColor(240, 253, 250);
    doc.roundedRect(x, y, kpiW, kpiH, 2, 2, 'F');
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 118, 110);
    doc.text(kpi.value, x + kpiW / 2, y + 7, { align: 'center' });
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(kpi.label, x + kpiW / 2, y + 13, { align: 'center' });
  });

  let curY = kpiY0 + 2 * (kpiH + kpiGap) + 8;

  // ── Staff Performance ────────────────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Staff Performance', 14, curY);

  const staffRows = Object.entries(staffMap).map(([name, d]) => [
    name, String(d.sales), `${formatKD(d.kd)} KD`, String(d.followups), String(d.lost),
  ]);
  autoTable(doc, {
    startY: curY + 3,
    head: [['Staff Member', 'Sales', 'Revenue (KD)', 'Follow-ups', 'Lost']],
    body: staffRows.length ? staffRows : [['—', '0', '0.000 KD', '0', '0']],
    theme: 'striped',
    headStyles: { fillColor: [15, 118, 110] },
    margin: { left: 14, right: 14 },
    styles: { fontSize: 9 },
  });
  curY = (doc as any).lastAutoTable.finalY + 8;

  // ── Brand Analytics ──────────────────────────────────────────────────────
  const hasBrandData = Object.keys(brandSalesMap).length > 0 || Object.keys(brandLostMap).length > 0;
  if (hasBrandData) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text('Brand Analytics', 14, curY);

    const allBrands = new Set([...Object.keys(brandSalesMap), ...Object.keys(brandLostMap)]);
    const brandRows = [...allBrands]
      .map(brand => {
        const s = brandSalesMap[brand] || { count: 0, kd: 0 };
        return { brand, sales: s.count, kd: s.kd, lost: brandLostMap[brand] || 0 };
      })
      .sort((a, b) => b.kd - a.kd || b.sales - a.sales)
      .map(({ brand, sales, kd, lost }) => [brand, String(sales), `${formatKD(kd)} KD`, String(lost)]);

    autoTable(doc, {
      startY: curY + 3,
      head: [['Brand', 'Sales', 'Revenue (KD)', 'Lost']],
      body: brandRows,
      theme: 'striped',
      headStyles: { fillColor: [15, 118, 110] },
      margin: { left: 14, right: 14 },
      styles: { fontSize: 9 },
    });
    curY = (doc as any).lastAutoTable.finalY + 8;
  }

  // ── All Cases table ──────────────────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('All Cases', 14, curY);

  const caseRows = cases.map(c => [
    c.timeLogged,
    c.staff,
    c.caseType,
    (c.customerName || '—').substring(0, 20),
    (c.brand || c.product || '—').substring(0, 25),
    c.amountKD ? formatKD(c.amountKD) : '—',
  ]);
  autoTable(doc, {
    startY: curY + 3,
    head: [['Time', 'Staff', 'Type', 'Customer', 'Brand / Product', 'KD']],
    body: caseRows,
    theme: 'striped',
    headStyles: { fillColor: [15, 118, 110] },
    margin: { left: 14, right: 14 },
    styles: { fontSize: 8 },
    columnStyles: { 5: { halign: 'right' } },
  });

  // ── Footer bar ────────────────────────────────────────────────────────────
  const pageH = doc.internal.pageSize.height;
  doc.setFillColor(10, 10, 10);
  doc.rect(0, pageH - 12, 210, 12, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(1.5);
  doc.setTextColor(180, 180, 180);
  doc.text('TIME KEEPER', 14, pageH - 5);
  doc.setCharSpace(0);
  doc.setTextColor(120, 120, 120);
  doc.text(`Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`, 196, pageH - 5, { align: 'right' });

  return doc.output('datauristring');
}

export function downloadReport(date: string, pdfUri: string) {
  const link = document.createElement('a');
  link.href = pdfUri;
  link.download = pdfFileName(date);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function shareReport(date: string, pdfUri: string): Promise<'shared' | 'downloaded'> {
  const fileName = pdfFileName(date);

  if (navigator.share) {
    try {
      const res = await fetch(pdfUri);
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: 'application/pdf' });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'TIME KEEPER Daily Report', files: [file] });
        return 'shared';
      } else {
        await navigator.share({ title: 'TIME KEEPER Daily Report' });
        return 'shared';
      }
    } catch {
      // User cancelled — fall through to download
    }
  }

  downloadReport(date, pdfUri);
  return 'downloaded';
}
