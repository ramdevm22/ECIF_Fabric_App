//  (adds the Tab 3 rules)

import { CURRENCIES, NO_DETAILS_WORK_TYPE, ROLES, SERVICE_LOCATIONS, WORK_TYPES } from '@rayfin-app/shared';
import type { Errors, RequestDraft } from './types';

// Limits copied from the Excel template.
export const LIMITS = { services: 4000, milestoneDescription: 4000, milestoneName: 100, milestones: 200 };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const todayStr = () => new Date().toISOString().slice(0, 10);

/** Latest milestone due date. Excel: =IF(MAX(J27:J227)=0,"",MAX(J27:J227)) */
export function projectEndDate(d: RequestDraft): string {
  const dates = d.milestones.map((m) => m.dueDate).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : '';
}

export const isBlank = (v: string) => v.trim() === '';

export function validateAccount(d: RequestDraft): Errors {
  const e: Errors = {};
  const req = (k: keyof RequestDraft, label: string) => {
    if (isBlank(String(d[k] ?? ''))) e[k] = `${label} is required`;
  };
  req('customerName', 'Customer name');
  req('customerContactName', 'Customer contact name');
  req('customerContactEmail', 'Customer contact email');
  req('serviceLocation', 'Service location');
  req('msRequestorName', 'Microsoft project requestor name');
  req('supplierName', 'ECIF supplier name');
  req('supplierId', 'Supplier ID');
  req('supplierContactName', 'Primary supplier contact name');
  req('supplierContactEmail', 'Primary supplier contact email');

  const emailCheck = (k: 'customerContactEmail' | 'supplierContactEmail' | 'additionalContactEmail') => {
    if (!isBlank(d[k]) && !EMAIL.test(d[k].trim())) e[k] = 'Enter a valid email address (not a group mailbox)';
  };
  emailCheck('customerContactEmail');
  emailCheck('supplierContactEmail');
  emailCheck('additionalContactEmail');

  if (!isBlank(d.supplierId) && !/^\d+$/.test(d.supplierId.trim())) e.supplierId = 'Supplier ID must be a whole number';
  if (!isBlank(d.serviceLocation) && !(SERVICE_LOCATIONS as readonly string[]).includes(d.serviceLocation))
    e.serviceLocation = 'Pick a location from the list';
  return e;
}

export function validateScope(d: RequestDraft): Errors {
  const e: Errors = {};
  if (isBlank(d.servicesDescription)) e.servicesDescription = 'Services to be provided is required';
  else if (d.servicesDescription.length > LIMITS.services) e.servicesDescription = `Max ${LIMITS.services} characters`;

  if (isBlank(d.projectStartDate)) e.projectStartDate = 'Project start date is required';
  else if (d.projectStartDate < todayStr()) e.projectStartDate = 'Past date cannot be selected';

  if (isBlank(d.currency)) e.currency = 'Currency is required';
  else if (!(CURRENCIES as readonly string[]).includes(d.currency)) e.currency = 'Pick a currency from the list';

  if (isBlank(d.travelExpenses)) e.travelExpenses = 'Enter 0 if you have no travel expenses';
  else if (!(Number(d.travelExpenses) >= 0)) e.travelExpenses = 'Must be a number, 0 or more';

  const end = projectEndDate(d);
  if (end && d.projectStartDate && end <= d.projectStartDate) e.projectEndDate = 'End date must be after the start date';

  const seen = new Map<string, number>();
  d.milestones.forEach((m, i) => {
    const p = `m${i}.`;
    const touched = m.name || m.description || m.workType || m.dueDate || m.amount;
    if (!touched) return; // Excel ignores rows with no milestone name; fully empty rows are fine
    if (isBlank(m.name)) e[p + 'name'] = 'Milestone name is required';
    else if (m.name.length > LIMITS.milestoneName) e[p + 'name'] = `Max ${LIMITS.milestoneName} characters`;
    else {
      const key = m.name.trim();
      if (seen.has(key)) e[p + 'name'] = 'Each milestone name must be unique';
      seen.set(key, i);
    }
    if (isBlank(m.description)) e[p + 'description'] = 'Description is required';
    else if (m.description.length > LIMITS.milestoneDescription) e[p + 'description'] = `Max ${LIMITS.milestoneDescription} characters`;
    if (isBlank(m.workType)) e[p + 'workType'] = 'Work type is required';
    else if (!(WORK_TYPES as readonly string[]).includes(m.workType)) e[p + 'workType'] = 'Pick a work type from the list';
    if (isBlank(m.dueDate)) e[p + 'dueDate'] = 'Due date is required';
    else if (d.projectStartDate && m.dueDate < d.projectStartDate) e[p + 'dueDate'] = 'Due date cannot be before the start date';
    if (!isBlank(m.amount) && !/^\d+$/.test(m.amount.trim())) e[p + 'amount'] = 'Whole number only';
  });
  return e;
}

/** Milestone Details rules (Tab 3). Milestones with "Temporary 3rd Party Licenses" work type are ignored. */
export function validateDetails(d: RequestDraft): Errors {
  const e: Errors = {};
  d.milestones.forEach((m, i) => {
    if (!m.name.trim() || m.workType === NO_DETAILS_WORK_TYPE) return;
    m.roles.forEach((r, j) => {
      const p = `m${i}.r${j}.`;
      const touched = r.role || r.resources || r.hoursPerResource || r.weeks;
      if (!touched) return; // empty lines are ignored
      if (isBlank(r.role)) e[p + 'role'] = 'Supplier role is required';
      else if (!(ROLES as readonly string[]).includes(r.role)) e[p + 'role'] = 'Pick a role from the list';
      if (isBlank(r.resources)) e[p + 'resources'] = 'Number of resources is required';
      else if (!/^\d{1,3}$/.test(r.resources.trim())) e[p + 'resources'] = 'Whole number, up to 3 digits';
      if (isBlank(r.hoursPerResource)) e[p + 'hoursPerResource'] = 'Hours per resource is required';
      else if (!/^\d{1,4}$/.test(r.hoursPerResource.trim())) e[p + 'hoursPerResource'] = 'Whole number, up to 4 digits';
      if (isBlank(r.weeks)) e[p + 'weeks'] = 'Number of weeks is required';
      else if (!/^\d{1,3}$/.test(r.weeks.trim())) e[p + 'weeks'] = 'Whole number, up to 3 digits';
    });
  });
  return e;
}

/** How many red (mandatory) fields are still empty - the Excel "red highlight" counter. */
export function countMissing(errors: Errors): number {
  return Object.values(errors).filter((m) => m.endsWith('required') || m.startsWith('Enter 0')).length;
}