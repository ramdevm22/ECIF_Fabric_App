import { ROLES } from '@rayfin-app/shared';
import { Field } from './Field';
import { acceptsDetails, milestoneHours, roleHours, totalHours } from '../calc';
import { emptyRole } from '../types';
import type { Errors, MilestoneDraft, RequestDraft, RoleDraft } from '../types';

interface Props {
  draft: RequestDraft;
  errors: Errors;
  onChange: (patch: Partial<RequestDraft>) => void;
}

/** Replicates the "Milestone Details" sheet. Role lines are grouped under their milestone. */
export function DetailsForm({ draft: d, errors: e, onChange }: Props) {
  const setMilestone = (i: number, patch: Partial<MilestoneDraft>) =>
    onChange({ milestones: d.milestones.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) });

  const setRole = (i: number, j: number, patch: Partial<RoleDraft>) =>
    setMilestone(i, { roles: d.milestones[i].roles.map((r, idx) => (idx === j ? { ...r, ...patch } : r)) });

  const addRole = (i: number) => setMilestone(i, { roles: [...d.milestones[i].roles, emptyRole()] });
  const removeRole = (i: number, j: number) =>
    setMilestone(i, { roles: d.milestones[i].roles.filter((_, idx) => idx !== j) });

  const named = d.milestones.map((m, i) => ({ m, i })).filter(({ m }) => m.name.trim() !== '');

  return (
    <div>
      <section className="card totals">
        <div><span>Milestones</span><strong>{named.length}</strong></div>
        <div><span>Milestone totals (hours)</span><strong>{totalHours(d).toLocaleString('en-US')}</strong></div>
      </section>

      {named.length === 0 && (
        <section className="card">
          <p className="hint">Add at least one milestone with a name on the "Project Scope" tab first.</p>
        </section>
      )}

      {named.map(({ m, i }) => (
        <section className="card" key={m.key}>
          <h2>{i + 1}. {m.name} <span className="muted">{m.workType || 'work type not chosen yet'}</span></h2>

          {!acceptsDetails(m) ? (
            <p className="hint">
              Details are not needed for "Temporary 3rd Party Licenses" milestones. Any details would be ignored
              when the request is imported, so they are not saved.
            </p>
          ) : (
            <>
              {m.roles.map((r, j) => {
                const p = `m${i}.r${j}.`;
                const touched = !!(r.role || r.resources || r.hoursPerResource || r.weeks);
                return (
                  <div className="role-row" key={r.key}>
                    <Field label="Supplier Role & Level" required={touched} value={r.role} error={e[p + 'role']}>
                      <select value={r.role} onChange={(ev) => setRole(i, j, { role: ev.target.value })}>
                        <option value="">Select a role</option>
                        {ROLES.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </Field>
                    <Field label="Number of resources" required={touched} value={r.resources} error={e[p + 'resources']}>
                      <input inputMode="numeric" maxLength={3} value={r.resources}
                        onChange={(ev) => setRole(i, j, { resources: ev.target.value })} />
                    </Field>
                    <Field label="Hours per resource" required={touched} value={r.hoursPerResource} error={e[p + 'hoursPerResource']}>
                      <input inputMode="numeric" maxLength={4} value={r.hoursPerResource}
                        onChange={(ev) => setRole(i, j, { hoursPerResource: ev.target.value })} />
                    </Field>
                    <Field label="Number of weeks" required={touched} value={r.weeks} error={e[p + 'weeks']}>
                      <input inputMode="numeric" maxLength={3} value={r.weeks}
                        onChange={(ev) => setRole(i, j, { weeks: ev.target.value })} />
                    </Field>
                    <div className="field">
                      <label>Total hours</label>
                      <input value={roleHours(r)} readOnly disabled />
                    </div>
                    <button type="button" className="link" onClick={() => removeRole(i, j)}>Remove</button>
                  </div>
                );
              })}
              <button type="button" className="secondary" onClick={() => addRole(i)}>+ Add role line</button>
              <div className="hint">Milestone hours: <strong>{milestoneHours(m).toLocaleString('en-US')}</strong></div>
            </>
          )}
        </section>
      ))}
    </div>
  );
}