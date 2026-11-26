//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { REVIEWER_EMAILS } from '@rayfin-app/shared';

/**
 * Policy helper: true for the reviewers listed in packages/shared/src/reviewers.ts.
 * `claims` is the signed-in user's claims object used inside @role policies.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isReviewer(claims: any) {
  const emails = REVIEWER_EMAILS.length > 0 ? REVIEWER_EMAILS : ['nobody@invalid.invalid'];
  return emails.map((e) => claims.email.eq(e.toLowerCase())).reduce((a, b) => a.or(b));
}