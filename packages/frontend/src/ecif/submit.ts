// The extra checks that run only when you press Submit.
import { acceptsDetails } from './calc';
import type { RequestDraft } from './types';

export interface SubmitCheck {
  blockers: string[]; // stop the submit
  warnings: string[]; // ask the user to confirm
}

/** Extra checks that only apply when submitting (the normal field rules are checked before). */
export function checkBeforeSubmit(d: RequestDraft): SubmitCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const named = d.milestones.filter((m) => m.name.trim() !== '');

  if (named.length === 0) blockers.push('Add at least one milestone on the Project Scope tab.');

  for (const m of named) {
    if (!(Number(m.amount) > 0)) warnings.push(`Milestone "${m.name}" has no amount.`);
    const hasRoles = m.roles.some((r) => r.role || r.resources || r.hoursPerResource || r.weeks);
    if (acceptsDetails(m) && !hasRoles) warnings.push(`Milestone "${m.name}" has no role lines on the Milestone Details tab.`);
  }
  return { blockers, warnings };
}