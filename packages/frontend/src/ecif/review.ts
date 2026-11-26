import { getRayfinClient } from '@/lib/rayfin-client';

export type Decision = 'approved' | 'rejected' | 'changes_requested';

export interface ReviewRow {
  id: string;
  customerName: string;
  supplierName: string;
  ownerEmail: string;
  currency: string;
  travelExpenses: number;
  updatedAt: string;
  total: number; // milestone amounts + travel
  decision: Decision | 'pending';
  approvedAmount: number | null;
}

export interface DecisionRow {
  id: string;
  decision: Decision;
  approvedAmount: number | null;
  comment: string;
  reviewerEmail: string;
  decidedAt: string;
}

const day = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '');
const time = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

async function client() {
  const c = await getRayfinClient();
  const session = c.auth.getSession();
  if (!session.isAuthenticated || !session.user) throw new Error('Not signed in.');
  return { c, email: (((session.user as { email?: string }).email) ?? '').toLowerCase() };
}

/** Latest decision per request id. */
function latestByRequest(rows: { request_id: string; decision: string; approvedAmount?: number | null; decidedAt: unknown }[]) {
  const map = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = map.get(r.request_id);
    if (!prev || time(r.decidedAt) > time(prev.decidedAt)) map.set(r.request_id, r);
  }
  return map;
}

/** All SUBMITTED requests (the database only lets reviewers see other people's). */
export async function listForReview(): Promise<ReviewRow[]> {
  const { c } = await client();
  const reqs = await c.data.EcifRequest
    .select(['id', 'customerName', 'supplierName', 'ownerEmail', 'currency', 'travelExpenses', 'updatedAt', 'status'])
    .where({ status: { eq: 'submitted' } })
    .orderBy({ updatedAt: 'desc' })
    .execute();
  const ms = await c.data.Milestone.select(['request_id', 'amount']).execute();
  const decisions = await c.data.ReviewDecision.select(['request_id', 'decision', 'approvedAmount', 'decidedAt']).execute();
  const latest = latestByRequest(decisions);

  return reqs.map((r) => {
    const sub = ms.filter((m) => m.request_id === r.id).reduce((a, m) => a + (m.amount ?? 0), 0);
    const d = latest.get(r.id);
    return {
      id: r.id,
      customerName: r.customerName ?? '',
      supplierName: r.supplierName ?? '',
      ownerEmail: r.ownerEmail ?? '',
      currency: r.currency ?? '',
      travelExpenses: Number(r.travelExpenses ?? 0),
      updatedAt: day(r.updatedAt),
      total: sub + Number(r.travelExpenses ?? 0),
      decision: (d?.decision as Decision) ?? 'pending',
      approvedAmount: d?.approvedAmount ?? null,
    };
  });
}

/** Decision history of one request, newest first (reviewers and the request owner can read it). */
export async function listDecisions(requestId: string): Promise<DecisionRow[]> {
  const { c } = await client();
  const rows = await c.data.ReviewDecision
    .select(['id', 'decision', 'approvedAmount', 'comment', 'reviewerEmail', 'decidedAt'])
    .where({ request_id: { eq: requestId } })
    .orderBy({ decidedAt: 'desc' })
    .execute();
  return rows.map((r) => ({
    id: r.id,
    decision: r.decision as Decision,
    approvedAmount: r.approvedAmount ?? null,
    comment: r.comment ?? '',
    reviewerEmail: r.reviewerEmail ?? '',
    decidedAt: day(r.decidedAt),
  }));
}

/** Records a decision. ownerId is the id of the request's owner, so the owner can read it. */
export async function decide(args: {
  requestId: string;
  ownerId: string;
  decision: Decision;
  approvedAmount?: number;
  comment?: string;
}): Promise<void> {
  const { c, email } = await client();
  await c.data.ReviewDecision.create({
    request_id: args.requestId,
    owner_id: args.ownerId,
    decision: args.decision,
    approvedAmount: args.decision === 'approved' ? args.approvedAmount : undefined,
    comment: args.comment?.trim() || undefined,
    reviewerEmail: email,
    decidedAt: new Date(),
  });
}

/** Owner id of a request (needed to copy into the decision row). */
export async function ownerOf(requestId: string): Promise<string> {
  const { c } = await client();
  const rows = await c.data.EcifRequest.select(['id', 'owner_id']).where({ id: { eq: requestId } }).execute();
  if (!rows[0]) throw new Error('Request not found');
  return rows[0].owner_id;
}

const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** CSV text of the list shown on the review screen (opens in Excel). */
export function reviewRowsToCsv(rows: ReviewRow[]): string {
  const head = ['Customer', 'Supplier', 'Requested by', 'Currency', 'Travel', 'Requested total', 'Status', 'Approved amount', 'Last updated'];
  const lines = [head.map(q).join(',')];
  for (const r of rows) {
    lines.push([r.customerName, r.supplierName, r.ownerEmail, r.currency, r.travelExpenses, r.total, r.decision, r.approvedAmount ?? '', r.updatedAt].map(q).join(','));
  }
  return '\ufeff' + lines.join('\r\n');
}
