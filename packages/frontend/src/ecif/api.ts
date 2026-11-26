import { NO_DETAILS_WORK_TYPE } from '@rayfin-app/shared';
import { getRayfinClient } from '@/lib/rayfin-client';
import { emptyDraft, newKey } from './types';
import type { MilestoneDraft, RequestDraft, RoleDraft } from './types';

// Dates: forms use 'yyyy-mm-dd'; the database gets a Date at UTC midnight.
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const toStr = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '');
const opt = (s: string) => (s.trim() === '' ? undefined : s.trim());
const isTouched = (r: RoleDraft) => !!(r.role || r.resources || r.hoursPerResource || r.weeks);

export interface RequestSummary {
  id: string;
  customerName: string;
  supplierName: string;
  updatedAt: string;
  status: 'draft' | 'submitted';
}

const REQUEST_FIELDS = [
  'id', 'customerName', 'customerContactName', 'customerContactEmail', 'serviceLocation',
  'msRequestorName', 'supplierName', 'supplierId', 'supplierContactName', 'supplierContactEmail',
  'additionalContactName', 'additionalContactEmail', 'servicesDescription', 'projectStartDate',
  'currency', 'travelExpenses', 'status',
] as const;

const MILESTONE_FIELDS = ['id', 'sortOrder', 'name', 'description', 'workType', 'dueDate', 'amount'] as const;
const ROLE_FIELDS = ['id', 'milestone_id', 'role', 'resources', 'hoursPerResource', 'weeks'] as const;

/** The client plus the signed-in user's id (stored in owner_id on every new row). */
async function context() {
  const client = await getRayfinClient();
  const session = client.auth.getSession();
  if (!session.isAuthenticated || !session.user) throw new Error('Not signed in.');
  const email = ((session.user as { email?: string }).email ?? '').toLowerCase();
  return { client, ownerId: session.user.id as string, email };
}

/** Who is signed in (used to decide whether to show the reviewer screen). */
export async function currentUser(): Promise<{ id: string; email: string }> {
  const { ownerId, email } = await context();
  return { id: ownerId, email };
}

export async function listRequests(): Promise<RequestSummary[]> {
  const { client, ownerId } = await context();
  // Only MY requests (reviewers can read other people's submitted requests too).
  const rows = await client.data.EcifRequest
    .select(['id', 'customerName', 'supplierName', 'updatedAt', 'status'])
    .where({ owner_id: { eq: ownerId } })
    .orderBy({ updatedAt: 'desc' })
    .execute();
  return rows.map((r) => ({
    id: r.id,
    customerName: r.customerName ?? '',
    supplierName: r.supplierName ?? '',
    updatedAt: toStr(r.updatedAt),
    status: r.status === 'submitted' ? 'submitted' : 'draft',
  }));
}

export async function loadRequest(id: string): Promise<RequestDraft> {
  const { client } = await context();
  const rows = await client.data.EcifRequest.select([...REQUEST_FIELDS]).where({ id: { eq: id } }).execute();
  const r = rows[0];
  if (!r) throw new Error('Request not found');

  const ms = await client.data.Milestone.select([...MILESTONE_FIELDS])
    .where({ request_id: { eq: id } })
    .orderBy({ sortOrder: 'asc' })
    .execute();

  // One query for the user's role lines, then group them by milestone here.
  const msIds = new Set(ms.map((m) => m.id));
  const allRoles = (await client.data.MilestoneRole.select([...ROLE_FIELDS]).execute())
    .filter((x) => msIds.has(x.milestone_id));

  const milestones: MilestoneDraft[] = ms.map((m) => ({
    key: newKey(), id: m.id, name: m.name ?? '', description: m.description ?? '',
    workType: m.workType ?? '', dueDate: toStr(m.dueDate), amount: String(m.amount ?? ''),
    roles: allRoles
      .filter((x) => x.milestone_id === m.id)
      .map((x) => ({
        key: newKey(), id: x.id, role: x.role ?? '', resources: String(x.resources ?? ''),
        hoursPerResource: String(x.hoursPerResource ?? ''), weeks: String(x.weeks ?? ''),
      })),
  }));

  return {
    ...emptyDraft(),
    id: r.id,
    status: r.status === 'submitted' ? 'submitted' : 'draft',
    customerName: r.customerName ?? '', customerContactName: r.customerContactName ?? '',
    customerContactEmail: r.customerContactEmail ?? '', serviceLocation: r.serviceLocation ?? '',
    msRequestorName: r.msRequestorName ?? '', supplierName: r.supplierName ?? '',
    supplierId: String(r.supplierId ?? ''),
    supplierContactName: r.supplierContactName ?? '', supplierContactEmail: r.supplierContactEmail ?? '',
    additionalContactName: r.additionalContactName ?? '', additionalContactEmail: r.additionalContactEmail ?? '',
    servicesDescription: r.servicesDescription ?? '', projectStartDate: toStr(r.projectStartDate),
    currency: r.currency ?? '', travelExpenses: String(r.travelExpenses ?? ''),
    milestones: milestones.length ? milestones : emptyDraft().milestones,
  };
}

/** Saves the whole draft (request, milestones and role lines). Returns it with database ids filled in. */
export async function saveRequest(d: RequestDraft): Promise<RequestDraft> {
  const { client, ownerId, email } = await context();
  const now = new Date();
  const fields = {
    customerName: d.customerName.trim(),
    customerContactName: d.customerContactName.trim(),
    customerContactEmail: d.customerContactEmail.trim(),
    serviceLocation: d.serviceLocation,
    msRequestorName: d.msRequestorName.trim(),
    supplierName: d.supplierName.trim(),
    supplierId: Number(d.supplierId),
    supplierContactName: d.supplierContactName.trim(),
    supplierContactEmail: d.supplierContactEmail.trim(),
    additionalContactName: opt(d.additionalContactName),
    additionalContactEmail: opt(d.additionalContactEmail),
    servicesDescription: d.servicesDescription,
    projectStartDate: toDate(d.projectStartDate),
    currency: d.currency,
    travelExpenses: Number(d.travelExpenses),
    updatedAt: now,
  };

  let requestId = d.id;
  if (requestId) {
    await client.data.EcifRequest.update({ id: requestId }, fields);
  } else {
    const created = await client.data.EcifRequest.create({
      ...fields, status: 'draft', createdAt: now, owner_id: ownerId, ownerEmail: email || undefined,
    });
    requestId = created.id;
  }

  const kept = d.milestones.filter((m) => m.name.trim() !== '');
  const keptIds = new Set(kept.map((m) => m.id).filter(Boolean));
  const existingMilestones = await client.data.Milestone.select(['id']).where({ request_id: { eq: requestId } }).execute();
  const existingRoles = await client.data.MilestoneRole.select(['id', 'milestone_id']).execute();

  // 1) Milestones removed in the form: delete their role lines first, then the milestone.
  for (const row of existingMilestones) {
    if (keptIds.has(row.id)) continue;
    for (const role of existingRoles.filter((x) => x.milestone_id === row.id)) {
      await client.data.MilestoneRole.delete({ id: role.id });
    }
    await client.data.Milestone.delete({ id: row.id });
  }

  // 2) Update or create every kept milestone, then sync its role lines.
  const saved: MilestoneDraft[] = [];
  for (let i = 0; i < kept.length; i++) {
    const m = kept[i];
    const mf = {
      sortOrder: i, name: m.name.trim(), description: m.description, workType: m.workType,
      dueDate: toDate(m.dueDate), amount: m.amount.trim() === '' ? 0 : Number(m.amount),
    };
    let milestoneId = m.id;
    if (milestoneId) {
      await client.data.Milestone.update({ id: milestoneId }, mf);
    } else {
      const c = await client.data.Milestone.create({ ...mf, owner_id: ownerId, request_id: requestId! });
      milestoneId = c.id;
    }

    // Role lines of "Temporary 3rd Party Licenses" milestones are ignored (like in the Excel template).
    const wanted = m.workType === NO_DETAILS_WORK_TYPE ? [] : m.roles.filter(isTouched);
    const wantedIds = new Set(wanted.map((r) => r.id).filter(Boolean));
    for (const old of existingRoles.filter((x) => x.milestone_id === milestoneId)) {
      if (!wantedIds.has(old.id)) await client.data.MilestoneRole.delete({ id: old.id });
    }

    const savedRoles: RoleDraft[] = [];
    for (const r of wanted) {
      const rf = {
        role: r.role,
        resources: Number(r.resources),
        hoursPerResource: Number(r.hoursPerResource),
        weeks: Number(r.weeks),
      };
      if (r.id) {
        await client.data.MilestoneRole.update({ id: r.id }, rf);
        savedRoles.push(r);
      } else {
        const created = await client.data.MilestoneRole.create({ ...rf, owner_id: ownerId, milestone_id: milestoneId });
        savedRoles.push({ ...r, id: created.id });
      }
    }
    saved.push({ ...m, id: milestoneId, roles: savedRoles });
  }
  return { ...d, id: requestId, milestones: saved.length ? saved : emptyDraft().milestones };
}

/** Marks a request as submitted (locked in the form) or back to draft. */
export async function setStatus(id: string, status: 'draft' | 'submitted'): Promise<void> {
  const { client } = await context();
  await client.data.EcifRequest.update({ id }, { status, updatedAt: new Date() });
}

/** Deletes a request together with all its milestones and role lines. */
export async function deleteRequest(id: string): Promise<void> {
  const { client } = await context();
    // Review decisions point to the request, so they must go first.
  // Only reviewers may delete them; a normal requester cannot.
  const decisions = await client.data.ReviewDecision.select(['id']).where({ request_id: { eq: id } }).execute();
  if (decisions.length > 0) {
    try {
      for (const d of decisions) await client.data.ReviewDecision.delete({ id: d.id });
    } catch {
      throw new Error('This request has already been reviewed, so it cannot be deleted. Ask a reviewer if it must be removed.');
    }
  }
  const milestones = await client.data.Milestone.select(['id']).where({ request_id: { eq: id } }).execute();
  const roles = await client.data.MilestoneRole.select(['id', 'milestone_id']).execute();
  const milestoneIds = new Set(milestones.map((m) => m.id));
  for (const r of roles) {
    if (milestoneIds.has(r.milestone_id)) await client.data.MilestoneRole.delete({ id: r.id });
  }
  for (const m of milestones) await client.data.Milestone.delete({ id: m.id });
  await client.data.EcifRequest.delete({ id });
}