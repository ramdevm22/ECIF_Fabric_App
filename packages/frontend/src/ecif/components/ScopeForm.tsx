/* Tab 2 */

import { CURRENCIES, WORK_TYPES } from '@rayfin-app/shared';
import { Field } from './Field';
import { LIMITS, projectEndDate } from '../validation';
import { emptyMilestone } from '../types';
import type { Errors, MilestoneDraft, RequestDraft } from '../types';

interface Props {
  draft: RequestDraft;
  errors: Errors;
  onChange: (patch: Partial<RequestDraft>) => void;
}

const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/* Replicates the "Project Scope" sheet: summary block + milestone rows (max 200). */
export function ScopeForm({ draft: d, errors: e, onChange }: Props) {
  const setMilestone = (i: number, patch: Partial<MilestoneDraft>) =>
    onChange({ milestones: d.milestones.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });
  const addMilestone = () => onChange({ milestones: [...d.milestones, emptyMilestone()] });
  const removeMilestone = (i: number) => {
    const next = d.milestones.filter((_, idx) => idx !== i);
    onChange({ milestones: next.length ? next : [emptyMilestone()] });
  };

  const subTotal = d.milestones.reduce((sum, m) => sum + (Number(m.amount) || 0), 0);
  const travel = Number(d.travelExpenses) || 0;
  const end = projectEndDate(d);

  return (
    <div>
      <section className="card">
        <h2>Project Summary</h2>
        <Field label="Services to be Provided" required value={d.servicesDescription} error={e.servicesDescription}
          counter={{ used: d.servicesDescription.length, max: LIMITS.services }}
          hint="Explain how the funds will be used: what is delivered, why, and how. Include milestone deliverables, products and services provided and the Microsoft tools used. The more ECIF you request, the more detail is expected.">
          <textarea rows={8} value={d.servicesDescription}
            onChange={(ev) => onChange({ servicesDescription: ev.target.value })} />
        </Field>

        <div className="row">
          <Field label="Project Start Date" required value={d.projectStartDate} error={e.projectStartDate}
            hint="ECIF approval can take up to 2 weeks. Consider this when choosing the start date.">
            <input type="date" value={d.projectStartDate} onChange={(ev) => onChange({ projectStartDate: ev.target.value })} />
          </Field>
          <Field label="Project End Date" required value={end} error={e.projectEndDate}
            hint="Calculated from the latest milestone due date. Cannot be edited.">
            <input type="date" value={end} readOnly disabled />
          </Field>
        </div>

        <div className="row">
          <Field label="Currency Name" required value={d.currency} error={e.currency}
            hint="The currency you expect to be paid in, as indicated in SupplierWeb.">
            <select value={d.currency} onChange={(ev) => onChange({ currency: ev.target.value })}>
              <option value="">Select a currency</option>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Travel Expenses" required value={d.travelExpenses} error={e.travelExpenses}
            hint='If you do not have any travel expenses, enter "0".'>
            <input type="number" min={0} value={d.travelExpenses} onChange={(ev) => onChange({ travelExpenses: ev.target.value })} />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>Project Milestones <span className="muted">({d.milestones.length} of {LIMITS.milestones})</span></h2>
        <p className="hint">
          Use a unique name for every milestone. The due date must be on or after the project start date.
          Describe the tasks, deliverables, where and how they are delivered, and who is responsible. Use full
          sentences and customer-specific details; avoid acronyms and estimates.
        </p>

        {d.milestones.map((m, i) => {
          const p = `m${i}.`;
          const touched = !!(m.name || m.description || m.workType || m.dueDate || m.amount);
          return (
            <div className="milestone" key={m.key}>
              <div className="milestone-head">
                <strong>Milestone {i + 1}</strong>
                <button type="button" className="link" onClick={() => removeMilestone(i)}>Remove</button>
              </div>
              <Field label="Project Milestone Name" required={touched} value={m.name} error={e[p + 'name']}
                counter={{ used: m.name.length, max: LIMITS.milestoneName }}>
                <input value={m.name} onChange={(ev) => setMilestone(i, { name: ev.target.value })} />
              </Field>
              <Field label="Milestone Description" required={touched} value={m.description} error={e[p + 'description']}
                counter={{ used: m.description.length, max: LIMITS.milestoneDescription }}>
                <textarea rows={5} value={m.description} onChange={(ev) => setMilestone(i, { description: ev.target.value })} />
              </Field>
              <Field label="Project Milestone Work Type" required={touched} value={m.workType} error={e[p + 'workType']}>
                <select value={m.workType} onChange={(ev) => setMilestone(i, { workType: ev.target.value })}>
                  <option value="">Select a work type</option>
                  {WORK_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
              </Field>
              <div className="row">
                <Field label="Milestone Due Date" required={touched} value={m.dueDate} error={e[p + 'dueDate']}>
                  <input type="date" min={d.projectStartDate || undefined} value={m.dueDate}
                    onChange={(ev) => setMilestone(i, { dueDate: ev.target.value })} />
                </Field>
                <Field label="Milestone Amount" value={m.amount} error={e[p + 'amount']} hint="Whole number, in the currency selected above.">
                  <input inputMode="numeric" value={m.amount} onChange={(ev) => setMilestone(i, { amount: ev.target.value })} />
                </Field>
              </div>
            </div>
          );
        })}

        {e.projectEndDate && <div className="error">{e.projectEndDate}</div>}
        <button type="button" className="secondary" disabled={d.milestones.length >= LIMITS.milestones} onClick={addMilestone}>
          + Add milestone
        </button>
      </section>

      <section className="card totals">
        <div><span>Milestone sub-total</span><strong>{money(subTotal)}</strong></div>
        <div><span>Travel expenses</span><strong>{money(travel)}</strong></div>
        <div><span>Project total</span><strong>{money(subTotal + travel)}</strong></div>
      </section>
    </div>
  );
}