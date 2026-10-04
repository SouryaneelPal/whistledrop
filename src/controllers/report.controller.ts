import { StatusUpdate } from '@prisma/client';
import { Request, Response } from 'express';
import { findIdentityLeaks } from '../services/leakCheck.service';
import { createReport, findReportByCaseCode } from '../services/report.service';
import { AppError } from '../utils/AppError';

// Built field by field so the reporter never sees which moderator handled their report.
function toReporterUpdate(update: Pick<StatusUpdate, 'status' | 'message' | 'createdAt'>) {
  return { status: update.status, message: update.message, createdAt: update.createdAt };
}

export async function submitReport(req: Request, res: Response) {
  const { caseCode, status } = await createReport(req.body);

  res.status(201).json({ caseCode, status, message: 'Save this case code. It cannot be recovered.' });
}

export async function trackReport(req: Request, res: Response) {
  // Read from a header rather than the URL so the code stays out of access logs and browser history.
  const caseCode = req.get('X-Case-Code');
  if (!caseCode) throw new AppError(400, 'MISSING_CASE_CODE', 'X-Case-Code header is required');

  const report = await findReportByCaseCode(caseCode);

  // Malformed and unknown codes get the same answer so nothing can be learned from the difference.
  if (!report) throw new AppError(404, 'CASE_NOT_FOUND', 'No report matches this case code');

  res.json({
    category: report.category,
    status: report.status,
    submittedAt: report.createdAt,
    updates: report.updates.map(toReporterUpdate),
  });
}

export function checkReport(req: Request, res: Response) {
  res.json({ warnings: findIdentityLeaks(req.body.description) });
}
