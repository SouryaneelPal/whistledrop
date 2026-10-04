import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFound } from './middleware/errorHandler';
import routes from './routes';
import docsRoutes from './routes/docs.routes';

const app = express();

// Behind a proxy every request seems to come from the proxy's IP, so limits would hit all users as one.
// Set this to the exact number of proxies: trusting more lets clients fake X-Forwarded-For.
if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (_req, res) => {
  res.redirect(302, '/docs/');
});

app.use('/docs', docsRoutes);

// Reports and tracking data must never be kept by browsers or proxies.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

export default app;
