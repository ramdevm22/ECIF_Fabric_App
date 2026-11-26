//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { date, entity, int, many, one, role, text, uuid } from '@microsoft/rayfin-core';
import { isReviewer } from './access.js';
import { EcifRequest } from './EcifRequest.js';
import { MilestoneRole } from './MilestoneRole.js';

/** One milestone row of the "Project Scope" sheet. */
@entity()
@role('authenticated', 'read', {
  policy: (claims, item) => isReviewer(claims).or(claims.sub.eq(item.owner_id)),
})
@role('authenticated', ['create', 'update', 'delete'], {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class Milestone {
  @uuid() id!: string;
  @int({ min: 0 }) sortOrder!: number;
  @text({ max: 100 }) name!: string;
  @text({ max: 4000 }) description!: string;
  @text({ max: 200 }) workType!: string;
  @date() dueDate!: Date;
  @int({ min: 0 }) amount!: number;
  @text({ max: 200 }) owner_id!: string;

  @uuid() request_id!: string;
  @one(() => EcifRequest) request?: EcifRequest;
  @many(() => MilestoneRole) roles?: MilestoneRole[];
}