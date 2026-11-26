//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { date, entity, int, one, role, set, text, uuid } from '@microsoft/rayfin-core';
import { isReviewer } from './access.js';
import { EcifRequest } from './EcifRequest.js';

/**
 * A reviewer's decision about a submitted request. A request can have several
 * decisions over time (for example "changes requested", then "approved"); the
 * latest one counts. Only reviewers write them; the request owner can read them.
 */
@entity()
@role('authenticated', 'read', {
  policy: (claims, item) => isReviewer(claims).or(claims.sub.eq(item.owner_id)),
})
@role('authenticated', ['create', 'update', 'delete'], {
  policy: (claims) => isReviewer(claims),
})
export class ReviewDecision {
  @uuid() id!: string;
  @set('approved', 'rejected', 'changes_requested') decision!: 'approved' | 'rejected' | 'changes_requested';
  @int({ optional: true, min: 0 }) approvedAmount?: number;
  @text({ optional: true, max: 2000 }) comment?: string;
  @text({ max: 200 }) reviewerEmail!: string;
  @date() decidedAt!: Date;
  @text({ max: 200 }) owner_id!: string; // the OWNER OF THE REQUEST (copied from it), so the owner can read the decision

  @uuid() request_id!: string;
  @one(() => EcifRequest) request?: EcifRequest;
}