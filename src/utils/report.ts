import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import type { Case } from '../types';
import { formatKD } from './formatKD';

export function buildDailyStats(cases: Case[]) {
  const sales = cases.filter(c => c.caseType === 'Sale');
  const followups = cases.filter(c => c.caseType === 'Follow-up');
  const lost = cases.filter(c => c.caseType === 'Lost Sale');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  const staffMap: Record<string, { sales: number; kd: number }> = {};
  for (const c of cases) {
    if (!staffMap[c.staff]) staffMap[c.staff] = { sales: 0, kd: 0 };
    if (c.caseType === 'Sale') {
      staffMap[c.staff].sales++;
      staffMap[c.staff].kd += c.amountKD || 0;
    }
  }

  return { sales, followups, lost, revenue, convRate, staffMap };
}

export function generatePDF(date: string, cases: Case[]): string {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const { sales, followups, lost, revenue, convRate, staffMap } = buildDailyStats(cases);

  const displayDate = format(new Date(date + 'T12:00:00'), 'd MMMM yyyy');

  // Header
  doc.setFillColor(15, 118, 110); // brand-700
  doc.rect(0, 0, 210, 32, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Watch Store — Daily Report', 14, 14);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(displayDate, 14, 24);

  // KPI tiles
  doc.setTextColor(30, 41, 59);
  const kpis = [
    { label: 'Revenue (KD)', value: formatKD(revenue) },
    { label: 'Sales', value: String(sales.length) },
    { label: 'Follow-ups', value: String(followups.length) },
    { label: 'Lost Sales', value: String(lost.length) },
    { label: 'Conversion', value: `${convRate}%` },
  ];
  let kpiX = 14;
  const kpiY = 40;
  const kpiW = 36;
  for (const kpi of kpis) {
    doc.setFillColor(240, 253, 250);
    doc.roundedRect(kpiX, kpiY, kpiW, 18, 2, 2, 'F');
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 118, 110);
    doc.text(kpi.value, kpiX + kpiW / 2, kpiY + 8, { align: 'center' });
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(kpi.label, kpiX + kpiW / 2, kpiY + 14, { align: 'center' });
    kpiX += kpiW + 2;
  }

  // Staff summary
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Staff Performance', 14, 70);

  const staffRows = Object.entries(staffMap).map(([name, data]) => [
    name, String(data.sales), `${formatKD(data.kd)} KD`,
  ]);
  autoTable(doc, {
    startY: 73,
    head: [['Staff Member', 'Sales', 'Revenue (KD)']],
    body: staffRows,
    theme: 'striped',
    headStyles: { fillColor: [15, 118, 110] },
    margin: { left: 14, right: 14 },
    styles: { fontSize: 9 },
  });

  // Case list
  const afterStaff = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Cases', 14, afterStaff);

  const caseRows = cases.map(c => [
    c.timeLogged,
    c.staff,
    c.caseType,
    (c.customerName || '—').substring(0, 20),
    c.product.substring(0, 25),
    c.amountKD ? formatKD(c.amountKD) : '—',
  ]);

  autoTable(doc, {
    startY: afterStaff + 3,
    head: [['Time', 'Staff', 'Type', 'Customer', 'Product', 'KD']],
    body: caseRows,
    theme: 'striped',
    headStyles: { fillColor: [15, 118, 110] },
    margin: { left: 14, right: 14 },
    styles: { fontSize: 8 },
    columnStyles: { 5: { halign: 'right' } },
  });

  // Footer
  const pageH = doc.internal.pageSize.height;
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(
    `Generated ${format(new Date(), 'dd MMM yyyy HH:mm')} · Watch Store Daily Log`,
    105, pageH - 8, { align: 'center' }
  );

  return doc.output('datauristring');
}

export async function shareReport(summary: string, pdfDataUri: string) {
  if (navigator.share) {
    try {
      // Convert data URI to blob for sharing
      const res = await fetch(pdfDataUri);
      const blob = await res.blob();
      const file = new File([blob], `daily-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`, { type: 'application/pdf' });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'Daily Report', text: summary, files: [file] });
      } else {
        await navigator.share({ title: 'Daily Report', text: summary });
      }
      return 'shared';
    } catch {
      // User cancelled or share failed — fall through to clipboard
    }
  }
  // Fallback: copy to clipboard
  await navigator.clipboard.writeText(summary);
  return 'copied';
}
