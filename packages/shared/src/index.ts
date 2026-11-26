/**
 * Browser-safe contracts shared by the data registration package and frontend.
 *
 * Keep each record shape aligned with its decorated runtime entity in
 * `@rayfin-app/data`. This package must stay isomorphic, so do not import the
 * decorated classes here.
 */

export * from './lookups.js';
export * from './reviewers.js';
export interface EcifRequestRecord {
  id: string;
  customerName: string;
  customerContactName: string;
  customerContactEmail: string;
  serviceLocation: string;
  msRequestorName: string;
  supplierName: string;
  supplierId: number;
  supplierContactName: string;
  supplierContactEmail: string;
  additionalContactName?: string;
  additionalContactEmail?: string;
  servicesDescription: string;
  projectStartDate: Date | string;
  currency: string;
  travelExpenses: number;
  status: 'draft' | 'submitted';
  createdAt: Date | string;
  updatedAt: Date | string;
  owner_id: string;
    ownerEmail?: string;
}

export interface MilestoneRecord {
  id: string;
  sortOrder: number;
  name: string;
  description: string;
  workType: string;
  dueDate: Date | string;
  amount: number;
  owner_id: string;
  request_id: string;
}

export interface MilestoneRoleRecord {
  id: string;
  role: string;
  resources: number;
  hoursPerResource: number;
  weeks: number;
  owner_id: string;
  milestone_id: string;
}

export interface ReviewDecisionRecord {
  id: string;
  decision: 'approved' | 'rejected' | 'changes_requested';
  approvedAmount?: number;
  comment?: string;
  reviewerEmail: string;
  decidedAt: Date | string;
  owner_id: string;
  request_id: string;
}
export type UniversalAppSchema = {
  EcifRequest: EcifRequestRecord;
  Milestone: MilestoneRecord;
  MilestoneRole: MilestoneRoleRecord;
  ReviewDecision: ReviewDecisionRecord;
};
