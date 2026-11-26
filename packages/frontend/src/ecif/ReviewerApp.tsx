import { useEffect, useMemo, useState } from 'react';
import { SummaryTab } from './components/SummaryTab';
import { loadRequest } from './api';
import { decide, listDecisions, listForReview, ownerOf, reviewRowsToCsv } from './review';
import type { Decision, DecisionRow, ReviewRow } from './review';
import { emptyDraft } from './types';
import type { RequestDraft } from './types';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const LABEL: Record<Decision | 'pending', string> = {
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected', changes_requested: 'Changes requested',
};

/** Reviewer screen: every submitted request, with approve / reject / request changes. */
export default function ReviewerApp() {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [filter, setFilter] = useState<Decision | 'pending' | 'all'>('pending');
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RequestDraft>(emptyDraft());
  const [history, setHistory] = useState<DecisionRow[]>([]);
  const [decision, setDecision] = useState<Decision>('approved');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = () =>
    listForReview().then(setRows).catch((e) => setMsg({ kind: 'err', text: errText(e) })).finally(() => setLoading(false));

  function exportList() {
    const blob = new Blob([reviewRowsToCsv(shown)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ECIF-requests-${filter}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  useEffect(() => { refresh(); }, []);

  const shown = useMemo(() => rows.filter((r) => filter === 'all' || r.decision === filter), [rows, filter]);
  const totalApproved = rows.filter((r) => r.decision === 'approved').reduce((a, r) => a + (r.approvedAmount ?? 0), 0);
  const current = rows.find((r) => r.id === openId);

  async function open(id: string) {
    setBusy(true); setMsg(null);
    try {
      const d = await loadRequest(id);
      setDraft(d); setOpenId(id);
      setHistory(await listDecisions(id));
      const row = rows.find((r) => r.id === id);
      setAmount(String(row?.total ?? '')); setComment(''); setDecision('approved');
    } catch (e) { setMsg({ kind: 'err', text: `Could not open: ${errText(e)}` }); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!openId) return;
    if (decision === 'approved' && !/^\d+$/.test(amount.trim())) {
      setMsg({ kind: 'err', text: 'Enter the approved amount as a whole number.' }); return;
    }
    if (decision !== 'approved' && comment.trim() === '') {
      setMsg({ kind: 'err', text: 'Please add a comment so the requester knows why.' }); return;
    }
    setBusy(true);
        try {
      await decide({
        requestId: openId, ownerId: await ownerOf(openId), decision,
        approvedAmount: decision === 'approved' ? Number(amount) : undefined, comment,
      });
      // Close the decision and details panels, go back to the list.
      setOpenId(null);
      setDraft(emptyDraft());
      setHistory([]);
      setComment('');
      setFilter('all');
      setMsg({ kind: 'ok', text: 'Decision saved.' });
      await refresh();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { setMsg({ kind: 'err', text: `Could not save decision: ${errText(e)}` }); }
    finally { setBusy(false); }
  }

  return (
    <div className="ecif">
      <header className="topbar">
        <h1>ECIF review <span className="chip chip-submitted">Reviewer</span></h1>
        <div className="actions">
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="changes_requested">Changes requested</option>
            <option value="rejected">Rejected</option>
            <option value="all">All submitted</option>
          </select>
          <button type="button" className="secondary" onClick={refresh} disabled={busy}>Refresh</button>
          <button type="button" className="secondary" onClick={exportList} disabled={shown.length === 0}>Export list (CSV)</button>
        </div>
      </header>

      {msg && <div className={`banner ${msg.kind}`}>{msg.text}</div>}

      <section className="card totals no-print">
        <div><span>Submitted requests</span><strong>{rows.length}</strong></div>
        <div><span>Pending</span><strong>{rows.filter((r) => r.decision === 'pending').length}</strong></div>
        <div><span>Total approved (mixed currencies)</span><strong>{money(totalApproved)}</strong></div>
      </section>

      <section className="card no-print">
        <h2>Requests ({shown.length})</h2>
        {loading && <p className="hint">Loading requests...</p>}
        {!loading && shown.length === 0 && <p className="hint">Nothing here for this filter.</p>}
        <table className="review-table">
          <thead><tr><th>Customer</th><th>Supplier</th><th>Requested by</th><th>Total</th><th>Status</th><th /></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={r.id === openId ? 'sel' : ''}>
                <td>{r.customerName}</td><td>{r.supplierName}</td><td>{r.ownerEmail}</td>
                <td>{money(r.total)} {r.currency}</td>
                <td><span className={`chip ${r.decision === 'approved' ? 'chip-submitted' : 'chip-draft'}`}>{LABEL[r.decision]}</span></td>
                <td><button type="button" className="secondary" onClick={() => open(r.id)} disabled={busy}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {openId && (
        <>
          <section className="card no-print">
            <h2>Decision for {current?.customerName} / {current?.supplierName}</h2>
            <div className="row">
              <div className="field">
                <label>Decision</label>
                <select value={decision} onChange={(e) => setDecision(e.target.value as Decision)}>
                  <option value="approved">Approve</option>
                  <option value="changes_requested">Request changes</option>
                  <option value="rejected">Reject</option>
                </select>
              </div>
              {decision === 'approved' && (
                <div className="field">
                  <label>Approved amount ({current?.currency})</label>
                  <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  <div className="hint">Pre-filled with the requested total. Change it if you approve less.</div>
                </div>
              )}
            </div>
            <div className="field">
              <label>Comment {decision !== 'approved' && <span className="star">*</span>}</label>
              <textarea rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
            </div>
            <button type="button" onClick={save} disabled={busy}>{busy ? 'Working...' : 'Save decision'}</button>

            {history.length > 0 && (
              <>
                <h2 style={{ marginTop: 16 }}>History</h2>
                <ul>
                  {history.map((h) => (
                    <li key={h.id}>
                      {h.decidedAt} - {LABEL[h.decision]}{h.approvedAmount != null && ` (${money(h.approvedAmount)})`} by {h.reviewerEmail}
                      {h.comment && `: ${h.comment}`}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <h2 className="no-print" style={{ margin: '16px 0 8px' }}>Request details (read-only)</h2>
          <SummaryTab draft={draft} />
        </>
      )}
    </div>
  );
}