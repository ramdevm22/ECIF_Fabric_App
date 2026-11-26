// What the forms edit. Dates are 'yyyy-mm-dd' strings, numbers are strings
// (so a half-typed number never breaks the input).
export interface RoleDraft {
  key: string;
  id?: string;
  role: string;
  resources: string;
  hoursPerResource: string;
  weeks: string;
}

export interface MilestoneDraft {
  key: string;          // local-only id for React lists
  id?: string;          // database id once saved
  name: string;
  description: string;
  workType: string;
  dueDate: string;
  amount: string;
  roles: RoleDraft[];   // Milestone Details lines (Tab 3)
}

export interface RequestDraft {
  id?: string;
  status: 'draft' | 'submitted';
  // Account and Contact Info
  customerName: string;
  customerContactName: string;
  customerContactEmail: string;
  serviceLocation: string;
  msRequestorName: string;
  supplierName: string;
  supplierId: string;
  supplierContactName: string;
  supplierContactEmail: string;
  additionalContactName: string;
  additionalContactEmail: string;
  // Project Scope
  servicesDescription: string;
  projectStartDate: string;
  currency: string;
  travelExpenses: string;
  milestones: MilestoneDraft[];
}

export const newKey = () => Math.random().toString(36).slice(2);

export const emptyRole = (): RoleDraft => ({
  key: newKey(), role: '', resources: '', hoursPerResource: '', weeks: '',
});

export const emptyMilestone = (): MilestoneDraft => ({
  key: newKey(), name: '', description: '', workType: '', dueDate: '', amount: '', roles: [],
});

export const emptyDraft = (): RequestDraft => ({
  status: 'draft',
  customerName: '', customerContactName: '', customerContactEmail: '', serviceLocation: '',
  msRequestorName: '',
  supplierName: '', supplierId: '', supplierContactName: '', supplierContactEmail: '',
  additionalContactName: '', additionalContactEmail: '',
  servicesDescription: '', projectStartDate: '', currency: '', travelExpenses: '',
  milestones: [emptyMilestone()],
});

export type Errors = Record<string, string>;