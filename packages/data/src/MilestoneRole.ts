//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { entity, int, one, role, text, uuid } from '@microsoft/rayfin-core';
import { isReviewer } from './access.js';
import { Milestone } from './Milestone.js';

/** One role line of the "Milestone Details" sheet. */
@entity()
@role('authenticated', 'read', {
  policy: (claims, item) => isReviewer(claims).or(claims.sub.eq(item.owner_id)),
})
@role('authenticated', ['create', 'update', 'delete'], {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class MilestoneRole {
  @uuid() id!: string;
  @text({ max: 100 }) role!: string;
  @int({ min: 0, max: 999 }) resources!: number;
  @int({ min: 0, max: 9999 }) hoursPerResource!: number;
  @int({ min: 0, max: 999 }) weeks!: number;
  @text({ max: 200 }) owner_id!: string;

  @uuid() milestone_id!: string;
  @one(() => Milestone) milestone?: Milestone;
}