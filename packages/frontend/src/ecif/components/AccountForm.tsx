import { SERVICE_LOCATIONS } from '@rayfin-app/shared';
import { Field } from './Field';
import type { Errors, RequestDraft } from '../types';

interface Props {
  draft: RequestDraft;
  errors: Errors;
  onChange: (patch: Partial<RequestDraft>) => void;
}

/** Replicates the "Account and Contact Info" sheet. Hints are the sheet's guidance column. */
export function AccountForm({ draft: d, errors: e, onChange }: Props) {
  const text = (k: keyof RequestDraft, type = 'text') => (
    <input type={type} value={String(d[k] ?? '')} onChange={(ev) => onChange({ [k]: ev.target.value })} />
  );

  return (
    <div>
      <section className="card">
        <h2>Customer Details</h2>
        <Field label="Customer Name" required value={d.customerName} error={e.customerName}
          hint="This must be the Customer Company Name.">{text('customerName')}</Field>
        <Field label="Customer Contact Name" required value={d.customerContactName} error={e.customerContactName}
          hint="First and last name of the primary customer point of contact.">{text('customerContactName')}</Field>
        <Field label="Customer Contact Email" required value={d.customerContactEmail} error={e.customerContactEmail}
          hint="Email of the primary customer contact. Do not provide a group email address.">
          {text('customerContactEmail', 'email')}
        </Field>
        <Field label="Service Location" required value={d.serviceLocation} error={e.serviceLocation}
          hint="The location in which the ECIF project work will be done.">
          <select value={d.serviceLocation} onChange={(ev) => onChange({ serviceLocation: ev.target.value })}>
            <option value="">Select a location</option>
            {SERVICE_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </Field>
      </section>

      <section className="card">
        <h2>Microsoft Contact Details</h2>
        <Field label="Microsoft Project Requestor Name" required value={d.msRequestorName} error={e.msRequestorName}
          hint="First and last name of your Microsoft sales contact who will submit the ECIF request.">
          {text('msRequestorName')}
        </Field>
      </section>

      <section className="card">
        <h2>Supplier Details</h2>
        <Field label="ECIF Supplier Name" required value={d.supplierName} error={e.supplierName}
          hint="This must be the Supplier Company Name.">{text('supplierName')}</Field>
        <Field label="Supplier ID" required value={d.supplierId} error={e.supplierId}
          hint="The Supplier ID associated with the supplier company above.">{text('supplierId')}</Field>
        <Field label="Primary Supplier Contact Name" required value={d.supplierContactName} error={e.supplierContactName}
          hint="First and last name of the primary supplier point of contact.">{text('supplierContactName')}</Field>
        <Field label="Primary Supplier Contact Email" required value={d.supplierContactEmail} error={e.supplierContactEmail}
          hint="Do not provide a group email address, unless you have an exception with Microsoft.">
          {text('supplierContactEmail', 'email')}
        </Field>
        <Field label="Additional Supplier Contact Name" value={d.additionalContactName} error={e.additionalContactName}
          hint="The day-to-day contact leading the workstream with the customer and teams.">
          {text('additionalContactName')}
        </Field>
        <Field label="Additional Supplier Contact Email" value={d.additionalContactEmail} error={e.additionalContactEmail}>
          {text('additionalContactEmail', 'email')}
        </Field>
      </section>
    </div>
  );
}