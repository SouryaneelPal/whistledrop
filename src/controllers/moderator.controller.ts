import { Report, StatusUpdate } from '@prisma/client';
import { Request, Response } from 'express';
import { authenticate } from '../services/moderator.service';
import { addNote, changeStatus, findReport, findReports } from '../services/report.service';
import { triageReports } from '../services/triage.service';
import { AppError } from '../utils/AppError';
import { ListQuery } from '../validators/moderator.schema';

// Responses are built field by field so nothing like caseCodeHash can leak by accident.
type UpdateRow = Pick<StatusUpdate, 'status' | 'message' | 'createdAt'>;
type SummaryRow = Pick<Report, 'id' | 'category' | 'status' | 'description' | 'createdAt' | 'updatedAt'>;
type AuditedUpdateRow = UpdateRow & { moderator: { username: string } | null };
type DetailRow = SummaryRow & Pick<Report, 'evidenceUrl'> & { updates: AuditedUpdateRow[] };
type Triage = Awaited<ReturnType<typeof triageReports>>[number];

function toUpdate(update: UpdateRow) {
  return { status: update.status, message: update.message, createdAt: update.createdAt };
}

function toSummary(report: SummaryRow, triage: Triage) {
  return {
    id: report.id,
    category: report.category,
    status: report.status,
    descriptionPreview: report.description.slice(0, 120),
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    triage,
  };
}

function toDetail(report: DetailRow, triage: Triage) {
  return {
    id: report.id,
    category: report.category,
    description: report.description,
    evidenceUrl: report.evidenceUrl,
    status: report.status,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    updates: report.updates.map((update) => ({ ...toUpdate(update), by: update.moderator?.username ?? null })),
    triage,
  };
}

export async function login(req: Request, res: Response) {
  const { token, expiresIn } = await authenticate(req.body.username, req.body.password);

  res.json({ token, expiresIn });
}

export async function listReports(_req: Request, res: Response) {
  const query: ListQuery = res.locals.query;
  const { reports, total } = await findReports(query);
  const triage = await triageReports(reports);

  res.json({ data: reports.map((report, i) => toSummary(report, triage[i])), page: query.page, limit: query.limit, total });
}

export async function getReport(req: Request<{ id: string }>, res: Response) {
  const report = await findReport(req.params.id);
  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');

  const [triage] = await triageReports([report]);
  res.json(toDetail(report, triage));
}

export async function updateStatus(req: Request<{ id: string }>, res: Response) {
  const { report, update } = await changeStatus(
    req.params.id,
    req.body.status,
    req.body.message,
    res.locals.moderatorId,
  );

  res.json({
    report: { id: report.id, category: report.category, status: report.status, updatedAt: report.updatedAt },
    update: toUpdate(update),
  });
}

export async function createNote(req: Request<{ id: string }>, res: Response) {
  const update = await addNote(req.params.id, req.body.message, res.locals.moderatorId);

  res.status(201).json({ update: toUpdate(update) });
}
