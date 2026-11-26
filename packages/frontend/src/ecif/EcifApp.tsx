import { useEffect, useMemo, useState } from 'react';
import { AccountForm } from './components/AccountForm';
import { DetailsForm } from './components/DetailsForm';
import { ScopeForm } from './components/ScopeForm';
import { SummaryTab } from './components/SummaryTab';
import { listDecisions } from './review';
import type { DecisionRow } from './review';
import { deleteRequest, listRequests, loadRequest, saveRequest, setStatus } from './api';
import type { RequestSummary } from './api';
import { checkBeforeSubmit } from './submit';
import { emptyDraft } from './types';
import type { RequestDraft } from './types';
import { countMissing, validateAccount, validateDetails, validateScope } from './validation';
import './ecif.css';

type Tab = 'account' | 'scope' | 'details' | 'summary';
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function EcifApp() {
  const [draft, setDraft] = useState<RequestDraft>(emptyDraft());
  const [tab, setTab] = useState<Tab>('account');
  const [saved, setSaved] = useState<RequestSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false); // unsaved changes
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [latest, setLatest] = useState<DecisionRow | null>(null);
  const approved = latest?.decision === 'approved';
  const locked = draft.status === 'submitted';
  const accountErrors = useMemo(() => validateAccount(draft), [draft]);
  const scopeErrors = useMemo(() => validateScope(draft), [draft]);
  const detailsErrors = useMemo(() => validateDetails(draft), [draft]);
  const missingAccount = countMissing(accountErrors);
  const missingScope = countMissing(scopeErrors);
  const missingDetails = countMissing(detailsErrors);
  const hasErrors =
    Object.keys(accountErrors).length + Object.keys(scopeErrors).length + Object.keys(detailsErrors).length > 0;

  const refreshList = () => listRequests().then(setSaved).catch(() => setSaved([]));
  useEffect(() => { refreshList(); }, []);

  // Latest reviewer decision for the opened request.
  useEffect(() => {
    if (!draft.id || draft.status !== 'submitted') { setLatest(null); return; }
    listDecisions(draft.id).then((h) => setLatest(h[0] ?? null)).catch(() => setLatest(null));
  }, [draft.id, draft.status]);

  // Browser warning when closing or reloading the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (ev: BeforeUnloadEvent) => { ev.preventDefault(); ev.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const patch = (p: Partial<RequestDraft>) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); };
  const confirmDiscard = () => !dirty || window.confirm('You have unsaved changes. Discard them?');
  const fail = (what: string, err: unknown) => setMessage({ kind: 'err', text: `${what}: ${errText(err)}` });

  async function onSave() {
    if (hasErrors) {
      setMessage({ kind: 'err', text: 'Fix the highlighted fields on all tabs before saving.' });
      return;
    }
    setBusy(true);
    try {
      setDraft(await saveRequest(draft));
      setDirty(false);
      setMessage({ kind: 'ok', text: 'Saved.' });
      refreshList();
    } catch (err) { fail('Save failed', err); } finally { setBusy(false); }
  }

  async function onSubmit() {
    if (hasErrors) {
      setMessage({ kind: 'err', text: 'Fix the highlighted fields on all tabs before submitting.' });
      return;
    }
    const { blockers, warnings } = checkBeforeSubmit(draft);
    if (blockers.length) { setMessage({ kind: 'err', text: blockers.join(' ') }); return; }
    if (warnings.length && !window.confirm(`Submit anyway?\n\n- ${warnings.join('\n- ')}`)) return;
    setBusy(true);
    try {
      const savedDraft = await saveRequest(draft);
      await setStatus(savedDraft.id!, 'submitted');
      setDraft({ ...savedDraft, status: 'submitted' });
      setDirty(false);
      setMessage({ kind: 'ok', text: 'Submitted. The request is now locked. Use "Reopen" to edit it again.' });
      refreshList();
    } catch (err) { fail('Submit failed', err); } finally { setBusy(false); }
  }

  async function onReopen() {
    if (!draft.id || !window.confirm('Reopen this request for editing? It will go back to Draft.')) return;
    setBusy(true);
    try {
      await setStatus(draft.id, 'draft');
      setDraft((d) => ({ ...d, status: 'draft' }));
      setMessage({ kind: 'ok', text: 'Reopened. You can edit the request again.' });
      refreshList();
    } catch (err) { fail('Reopen failed', err); } finally { setBusy(false); }
  }

  async function onDelete() {
    if (!draft.id) return;
    if (!window.confirm('Delete this request with all its milestones and role lines? This cannot be undone.')) return;
    setBusy(true);
    try {
      await deleteRequest(draft.id);
      setDraft(emptyDraft());
      setDirty(false);
      setMessage({ kind: 'ok', text: 'Request deleted.' });
      refreshList();
    } catch (err) { fail('Delete failed', err); } finally { setBusy(false); }
  }

  async function onOpen(id: string) {
    if (!confirmDiscard()) return;
    if (!id) { setDraft(emptyDraft()); setDirty(false); setMessage(null); return; }
    setBusy(true);
    try { setDraft(await loadRequest(id)); setDirty(false); setMessage(null); }
    catch (err) { fail('Could not open', err); } finally { setBusy(false); }
  }

  const tabButton = (id: Tab, label: string, missing = 0) => (
    <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
      {label} {missing > 0 && !locked && <span className="badge">{missing}</span>}
    </button>
  );

  return (
    <div className="ecif">
      <header className="topbar no-print">
        <h1>
          ECIF Supplier Scope &amp; Milestones{' '}
          <span className={`chip ${locked ? 'chip-submitted' : 'chip-draft'}`}>{locked ? 'Submitted' : 'Draft'}</span>
          {dirty && <span className="chip chip-dirty">Unsaved changes</span>}
        </h1>
        <div className="actions">
          <select value={draft.id ?? ''} onChange={(ev) => onOpen(ev.target.value)} disabled={busy}>
            <option value="">+ New request</option>
            {saved.map((r) => (
              <option key={r.id} value={r.id}>
                [{r.status === 'submitted' ? 'Submitted' : 'Draft'}] {r.customerName} / {r.supplierName} ({r.updatedAt})
              </option>
            ))}
          </select>
          {!locked && <button type="button" onClick={onSave} disabled={busy}>{busy ? 'Working...' : 'Save request'}</button>}
          {!locked && <button type="button" className="secondary" onClick={onSubmit} disabled={busy}>Submit</button>}
          {locked && !approved && <button type="button" className="secondary" onClick={onReopen} disabled={busy}>Reopen</button>}
          {draft.id && <button type="button" className="danger" onClick={onDelete} disabled={busy}>Delete</button>}
        </div>
      </header>

      <nav className="tabs no-print">
        {tabButton('account', '1. Account & Contact Info', missingAccount)}
        {tabButton('scope', '2. Project Scope', missingScope)}
        {tabButton('details', '3. Milestone Details', missingDetails)}
        {tabButton('summary', '4. Summary')}
      </nav>

      {locked && (
        <div className="banner ok">
          {approved
            ? 'This request is approved and locked.'
            : 'This request is submitted and locked. Click "Reopen" to edit it.'}
        </div>
      )}
      {latest && (
        <div className="decision-banner">
          <strong>Reviewer decision: {latest.decision.replace('_', ' ')}</strong>
          {latest.approvedAmount != null && ` - approved amount ${latest.approvedAmount.toLocaleString('en-US')}`}
          {latest.comment && <div>{latest.comment}</div>}
        </div>
      )}
      {message && <div className={`banner ${message.kind}`}>{message.text}</div>}

      <main>
        {tab !== 'summary' && (
          <fieldset className="lock" disabled={locked || busy}>
            {tab === 'account' && <AccountForm draft={draft} errors={accountErrors} onChange={patch} />}
            {tab === 'scope' && <ScopeForm draft={draft} errors={scopeErrors} onChange={patch} />}
            {tab === 'details' && <DetailsForm draft={draft} errors={detailsErrors} onChange={patch} />}
          </fieldset>
        )}
        {tab === 'summary' && <SummaryTab draft={draft} />}
      </main>
    </div>
  );
}