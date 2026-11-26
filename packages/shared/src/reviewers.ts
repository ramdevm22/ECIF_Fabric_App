/*
 * People who may review ALL submitted ECIF requests (lower-case email addresses).
 *
 * Used in two places:
 *  - the database access rules (packages/data/src/access.ts) - this is the real protection
 *  - the screens, to show the review panel - only a convenience
 */
export const REVIEWER_EMAILS: readonly string[] = [
  'Ramdev.Meghwal@sonata-software.com', // Reviewer email
];

export const isReviewerEmail = (email?: string | null): boolean =>
  !!email && REVIEWER_EMAILS.some((e) => e.toLowerCase() === email.trim().toLowerCase());