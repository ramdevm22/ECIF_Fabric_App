//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { EcifRequest } from './EcifRequest.js';
import { Milestone } from './Milestone.js';
import { MilestoneRole } from './MilestoneRole.js';
import { ReviewDecision } from './ReviewDecision.js';
import type { UniversalAppSchema } from '@rayfin-app/shared';

export type { UniversalAppSchema };
export { EcifRequest, Milestone, MilestoneRole, ReviewDecision };

export const schema = [EcifRequest, Milestone, MilestoneRole, ReviewDecision];