import { Router } from 'express';
import { checkReport, submitReport, trackReport } from '../controllers/report.controller';
import { checkLimiter, submitLimiter, trackLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { checkSchema, reportSchema } from '../validators/report.schema';

const router = Router();

router.post('/', submitLimiter, validate(reportSchema), submitReport);
router.get('/status', trackLimiter, trackReport);
router.post('/check', checkLimiter, validate(checkSchema), checkReport);

export default router;
