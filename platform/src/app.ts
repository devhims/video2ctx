import { documentationApp } from './docs';
import createApp from './lib/create-app';
import { applicationCors, betterAuthContext, establishPrincipal } from './middlewares';
import indexRoutes from './routes/index.route';
import { dataRoutes } from './routes/data/data.index';
import { publicRoutes } from './routes/public/public.index';
import { sessionRoutes } from './routes/session/session.index';

export const app = createApp();

app.route('/', documentationApp);
app.route('/', indexRoutes);

app.use('/api/auth/*', applicationCors);
app.use('/api/auth/*', betterAuthContext);
app.on(['GET', 'POST'], '/api/auth/*', (c) => c.get('auth')!.handler(c.req.raw));

app.use('/v1/*', applicationCors);
app.route('/v1', publicRoutes);
app.use('/v1/*', establishPrincipal);

app.route('/v1', dataRoutes);
app.route('/v1', sessionRoutes);

export default app;
