import { buildSummary, summaryToCsv } from '../calc';
import type { RequestDraft } from '../types';

const n = (v: number | null) => (v === null ? '' : v.toLocaleString('en-US'));

/** Replicates the hidden "Milestone Table Final" sheet (read-only). */
export function SummaryTab({ draft: d }: { draft: RequestDraft }) {
  const s = buildSummary(d);

  function download() {
    const blob = new Blob([summaryToCsv(d, s)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ECIF-summary-${(d.customerName || 'request').replace(/[^\w-]+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <section className="card print-only">
        <h2>ECIF Supplier Scope &amp; Milestones</h2>
        <p>
          <strong>Customer:</strong> {d.customerName} ({d.customerContactName}, {d.customerContactEmail})<br />
          <strong>Supplier:</strong> {d.supplierName} (ID {d.supplierId}; {d.supplierContactName}, {d.supplierContactEmail})<br />
          <strong>Microsoft requestor:</strong> {d.msRequestorName} &nbsp; <strong>Service location:</strong> {d.serviceLocation}<br />
          <strong>Start date:</strong> {d.projectStartDate} &nbsp; <strong>Currency:</strong> {d.currency}
        </p>
        <p><strong>Services to be provided:</strong><br />{d.servicesDescription}</p>
      </section>
      <section className="card">
        <div className="summary-head">
          <h2>Milestone Summary</h2>
          <div className="actions no-print">
            <button type="button" className="secondary" onClick={download} disabled={s.rows.length === 0}>
              Download CSV (Excel)
            </button>
            <button type="button" className="secondary" onClick={() => window.print()} disabled={s.rows.length === 0}>
              Print / Save as PDF
            </button>
          </div>
        </div>
        <p className="hint">
          Read-only view of Tabs 2 and 3. Amounts are in {d.currency || 'the selected currency'}. The USD and
          local-currency conversion of the Excel sheet is not included, because the exchange rates are not part of
          the template. "Months" is estimated as weeks divided by 4.33.
        </p>

        {s.rows.length === 0 ? (
          <p className="hint">No milestones yet. Add them on the "Project Scope" tab.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Milestone</th><th>Description</th><th>Work type</th><th>Supplier role</th>
                  <th>Resources</th><th>Hours / resource</th><th>Months</th><th>Hours / month</th>
                  <th>Total hours</th><th>Due date</th><th>Amount ({d.currency || '...'})</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r, idx) => (
                  <tr key={idx}>
                    <td>{r.milestoneNo}</td><td>{r.name}</td><td className="desc">{r.description}</td>
                    <td>{r.workType}</td><td>{r.role}</td><td>{n(r.resources)}</td>
                    <td>{n(r.hoursPerResource)}</td><td>{n(r.months)}</td><td>{n(r.hoursPerMonth)}</td>
                    <td>{n(r.totalHours)}</td><td>{r.dueDate}</td><td>{n(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={5}>Sub-Total</td><td>{n(s.subTotalResources)}</td><td colSpan={3}></td>
                  <td>{n(s.subTotalHours)}</td><td></td><td>{n(s.subTotalAmount)}</td></tr>
                <tr><td colSpan={11}>Travel Expenses (if any)</td><td>{n(s.travel)}</td></tr>
                <tr><td colSpan={11}><strong>Project Total</strong></td><td><strong>{n(s.projectTotal)}</strong></td></tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}