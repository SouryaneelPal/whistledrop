import path from 'node:path';
import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';

// The build copies the spec next to the compiled routes, so this path works from src/ and dist/.
const spec = YAML.load(path.join(__dirname, '../docs/openapi.yaml'));

const router = Router();

// Over plain http (not localhost), upgrade-insecure-requests makes Swagger UI load its assets over
// https and fail. Only that directive is dropped, and only here.
router.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
router.use(swaggerUi.serve);
router.get('/', swaggerUi.setup(spec));

export default router;
