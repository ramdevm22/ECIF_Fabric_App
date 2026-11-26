//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { date, decimal, entity, int, many, role, set, text, uuid } from '@microsoft/rayfin-core';
import { isReviewer } from './access.js';
import { Milestone } from './Milestone.js';
import { ReviewDecision } from './ReviewDecision.js';

/** One ECIF request*/
@entity()
// Reviewers read submitted requests of everybody; everyone reads their own.
@role('authenticated', 'read', {
  policy: (claims, item) =>
    isReviewer(claims).and(item.status.eq('submitted')).or(claims.sub.eq(item.owner_id)),
})
// Only the owner creates, edits and deletes.
@role('authenticated', ['create', 'update', 'delete'], {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class EcifRequest {
  @uuid() id!: string;

  // Sheet 1: Account and Contact Info
  @text({ max: 200 }) customerName!: string;
  @text({ max: 200 }) customerContactName!: string;
  @text({ max: 200 }) customerContactEmail!: string;
  @text({ max: 100 }) serviceLocation!: string;
  @text({ max: 200 }) msRequestorName!: string;
  @text({ max: 200 }) supplierName!: string;
  @int({ min: 0 }) supplierId!: number;
  @text({ max: 200 }) supplierContactName!: string;
  @text({ max: 200 }) supplierContactEmail!: string;
  @text({ optional: true, max: 200 }) additionalContactName?: string;
  @text({ optional: true, max: 200 }) additionalContactEmail?: string;

  // Sheet 2: Project Scope (summary part)
  @text({ max: 4000 }) servicesDescription!: string;
  @date() projectStartDate!: Date;
  @text({ max: 100 }) currency!: string;
  @decimal({ min: 0 }) travelExpenses!: number;

  @set('draft', 'submitted') status!: 'draft' | 'submitted';
  @date() createdAt!: Date;
  @date() updatedAt!: Date;
  @text({ max: 200 }) owner_id!: string;
  @text({ optional: true, max: 200 }) ownerEmail?: string; // who created it (readable, for reviewers and Power BI)

  @many(() => Milestone) milestones?: Milestone[];
  @many(() => ReviewDecision) decisions?: ReviewDecision[];
}