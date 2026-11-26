// Totals, the summary table and the CSV export.
import { NO_DETAILS_WORK_TYPE } from '@rayfin-app/shared';
import type { MilestoneDraft, RequestDraft, RoleDraft } from './types';

/**
 * ASSUMPTION: the Excel summary shows "Number of Months" but its formula is hidden
 * (the sheet is locked and filled by a macro). We convert weeks to months with
 * 52 / 12 weeks per month. Confirm the real rule and change it here if needed.
 */
export const WEEKS_PER_MONTH = 52 / 12;

export const num = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s) : 0);
export const roleHours = (r: RoleDraft) => num(r.resources) * num(r.hoursPerResource);
export const acceptsDetails = (m: MilestoneDraft) => m.workType !== NO_DETAILS_WORK_TYPE;
const isTouched = (r: RoleDraft) => !!(r.role || r.resources || r.hoursPerResource || r.weeks);

export const milestoneHours = (m: MilestoneDraft) =>
  acceptsDetails(m) ? m.roles.reduce((sum, r) => sum + roleHours(r), 0) : 0;

export const totalHours = (d: RequestDraft) =>
  d.milestones.reduce((sum, m) => sum + milestoneHours(m), 0);

export const weeksToMonths = (weeks: number) => Math.round((weeks / WEEKS_PER_MONTH) * 10) / 10;

export interface SummaryRow {
  milestoneNo: number;
  name: string;
  description: string;
  workType: string;
  role: string;
  resources: number | null;
  hoursPerResource: number | null;
  months: number | null;
  hoursPerMonth: number | null;
  totalHours: number | null;
  dueDate: string;
  amount: number | null; // only on the first row of a milestone, so it is never counted twice
}

export interface Summary {
  rows: SummaryRow[];
  subTotalResources: number;
  subTotalHours: number;
  subTotalAmount: number;
  travel: number;
  projectTotal: number;
}

/** Replicates the hidden "Milestone Table Final" sheet. */
export function buildSummary(d: RequestDraft): Summary {
  const rows: SummaryRow[] = [];
  let no = 0;
  let subTotalResources = 0;
  let subTotalHours = 0;
  let subTotalAmount = 0;

  for (const m of d.milestones) {
    if (!m.name.trim()) continue;
    no += 1;
    const amount = num(m.amount);
    subTotalAmount += amount;
    const base = { milestoneNo: no, name: m.name.trim(), description: m.description, workType: m.workType, dueDate: m.dueDate };
    const lines = acceptsDetails(m) ? m.roles.filter(isTouched) : [];

    if (lines.length === 0) {
      rows.push({ ...base, role: '', resources: null, hoursPerResource: null, months: null, hoursPerMonth: null, totalHours: null, amount });
      continue;
    }
    lines.forEach((r, idx) => {
      const resources = num(r.resources);
      const hrs = num(r.hoursPerResource);
      const months = weeksToMonths(num(r.weeks));
      const total = resources * hrs;
      subTotalResources += resources;
      subTotalHours += total;
      rows.push({
        ...base, role: r.role, resources, hoursPerResource: hrs, months,
        hoursPerMonth: months > 0 ? Math.round(total / months) : null,
        totalHours: total, amount: idx === 0 ? amount : null,
      });
    });
  }

  const travel = Number(d.travelExpenses) || 0;
  return { rows, subTotalResources, subTotalHours, subTotalAmount, travel, projectTotal: subTotalAmount + travel };
}

const q = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV text of the summary (opens in Excel). */
export function summaryToCsv(d: RequestDraft, s: Summary): string {
  const head = [
    'Project Milestone #', 'Milestone Name', 'Milestone Description', 'Project Milestone Work Type', 'Supplier role',
    'Number of Resources', 'Hours Required Per Resource', 'Number of Months', 'Effort in Hours per month',
    'Total Hours Required', 'Milestone Due Date', `Milestone Amount (${d.currency || 'currency'})`,
  ];
  const lines = [head.map(q).join(',')];
  for (const r of s.rows) {
    lines.push([r.milestoneNo, r.name, r.description, r.workType, r.role, r.resources, r.hoursPerResource, r.months,
      r.hoursPerMonth, r.totalHours, r.dueDate, r.amount].map(q).join(','));
  }
  lines.push(['Sub-Total', '', '', '', '', s.subTotalResources, '', '', '', s.subTotalHours, '', s.subTotalAmount].map(q).join(','));
  lines.push(['Travel Expenses', '', '', '', '', '', '', '', '', '', '', s.travel].map(q).join(','));
  lines.push(['Project Total', '', '', '', '', '', '', '', '', '', '', s.projectTotal].map(q).join(','));
  return '﻿' + lines.join('\r\n');
}