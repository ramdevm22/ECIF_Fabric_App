import { describe, expect, it } from 'vitest';
import { buildSummary, milestoneHours, summaryToCsv, totalHours } from './calc';
import { checkBeforeSubmit } from './submit';
import { emptyDraft, emptyMilestone, emptyRole } from './types';
import { validateDetails, validateScope } from './validation';
import type { RequestDraft } from './types';

const role = (resources: string, hours: string, weeks: string) =>
  ({ ...emptyRole(), role: 'Project Manager', resources, hoursPerResource: hours, weeks });

function sample(): RequestDraft {
  const d = emptyDraft();
  d.currency = 'US Dollar';
  d.travelExpenses = '500';
  d.projectStartDate = '2099-01-01';
  d.milestones = [
    { ...emptyMilestone(), name: 'Design', description: 'd', workType: 'Build', dueDate: '2099-02-01', amount: '1000',
      roles: [role('2', '40', '8'), role('1', '10', '4')] },
    { ...emptyMilestone(), name: 'Licenses', description: 'l', workType: 'Temporary 3rd Party Licenses (Pre-Sales)',
      dueDate: '2099-03-01', amount: '250', roles: [role('9', '9', '9')] },
  ];
  return d;
}

describe('hours and totals', () => {
  it('multiplies resources by hours and sums milestone hours', () => {
    const d = sample();
    expect(milestoneHours(d.milestones[0])).toBe(90);
    expect(totalHours(d)).toBe(90);
  });
  it('ignores role lines of "Temporary 3rd Party Licenses" milestones', () => {
    expect(milestoneHours(sample().milestones[1])).toBe(0);
  });
});

describe('summary', () => {
  it('shows each milestone amount once and adds travel', () => {
    const s = buildSummary(sample());
    expect(s.rows).toHaveLength(3);
    expect(s.subTotalHours).toBe(90);
    expect(s.subTotalResources).toBe(3);
    expect(s.subTotalAmount).toBe(1250);
    expect(s.projectTotal).toBe(1750);
    expect(s.rows[1].amount).toBeNull();
  });
  it('writes a CSV with a header, one line per row and three total lines', () => {
    const d = sample();
    expect(summaryToCsv(d, buildSummary(d)).split('\r\n')).toHaveLength(1 + 3 + 3);
  });
});

describe('validation', () => {
  it('rejects a past start date and accepts a future one', () => {
    const d = sample();
    d.projectStartDate = '2000-01-01';
    expect(validateScope(d).projectStartDate).toBeDefined();
    d.projectStartDate = '2099-01-01';
    expect(validateScope(d).projectStartDate).toBeUndefined();
  });
  it('rejects duplicate milestone names', () => {
    const d = sample();
    d.milestones[1].name = 'Design';
    expect(validateScope(d)['m1.name']).toMatch(/unique/);
  });
  it('requires all four fields once a role line is started', () => {
    const d = sample();
    d.milestones[0].roles = [{ ...emptyRole(), role: 'Project Manager' }];
    const e = validateDetails(d);
    expect(e['m0.r0.resources']).toBeDefined();
    expect(e['m0.r0.hoursPerResource']).toBeDefined();
    expect(e['m0.r0.weeks']).toBeDefined();
  });
  it('limits resources to 3 digits and hours to 4 digits', () => {
    const d = sample();
    d.milestones[0].roles = [role('1234', '12345', '8')];
    const e = validateDetails(d);
    expect(e['m0.r0.resources']).toBeDefined();
    expect(e['m0.r0.hoursPerResource']).toBeDefined();
  });
});

describe('submit checks', () => {
  it('blocks a request with no milestone', () => {
    expect(checkBeforeSubmit(emptyDraft()).blockers).toHaveLength(1);
  });
  it('warns about a milestone without role lines', () => {
    const d = sample();
    d.milestones[0].roles = [];
    expect(checkBeforeSubmit(d).warnings.some((w) => w.includes('Design'))).toBe(true);
  });
});