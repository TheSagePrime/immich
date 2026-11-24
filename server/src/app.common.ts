import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'body-parser';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmetMiddleware from 'helmet';
import { existsSync } from 'node:fs';
import sirv from 'sirv';
import { IMMICH_SERVER_START, excludePaths, serverVersion } from 'src/constants.js';
import { MaintenanceWorkerService } from 'src/maintenance/maintenance-worker.service.js';
import { WebSocketAdapter } from 'src/middleware/websocket.adapter.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { bootstrapTelemetry } from 'src/repositories/telemetry.repository.js';
import { ApiService } from 'src/services/api.service.js';
import { SecurityHeadersService } from 'src/services/security-headers.service.js';
import { useSwagger } from 'src/utils/misc.js';
import { createSecurityHeaders } from 'src/utils/security-headers.js';

export function configureTelemetry() {
  const { telemetry } = new ConfigRepository().getEnv();
  if (telemetry.metrics.size > 0) {
    bootstrapTelemetry(telemetry.apiPort);
  }
}

export async function configureExpress(
  app: NestExpressApplication,
  {
    permitSwaggerWrite = true,
    ssr,
    securityHeaders,
  }: {
    /**
    Whether to allow swagger module to write to the specs.json
    This is not desirable when the API is not available
    @default true
    */
    permitSwaggerWrite?: boolean;
    /** Service to use for server-side rendering */
    ssr: typeof ApiService | typeof MaintenanceWorkerService;
    /** Service that sets the security headers, with live system config */
    securityHeaders?: typeof SecurityHeadersService;
  },
) {
  const configRepository = app.get(ConfigRepository);
  const { environment, host, port, helmet, resourcePaths, network, security } = configRepository.getEnv();

  const logger = await app.resolve(LoggingRepository);
  logger.setContext('Bootstrap');
  app.useLogger(logger);

  app.set('trust proxy', ['loopback', ...network.trustedProxies]);
  app.set('etag', 'strong');

  if (helmet.config) {
    app.use(helmetMiddleware(helmet.config));
    logger.log('Initialized helmet middleware');
  }

  if (securityHeaders) {
    app.use(app.get(securityHeaders).middleware());
  } else {
    const { messages, middleware } = createSecurityHeaders({
      helmetPolicy: !!helmet.config?.contentSecurityPolicy,
      contentSecurityPolicy: security.contentSecurityPolicy,
      webRoot: resourcePaths.web.root,
    });
    for (const message of messages) {
      logger.warn(message);
    }
    app.use(middleware);
  }

  app.use(cookieParser());
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb' }));

  if (configRepository.isDev()) {
    app.enableCors();
  }

  app.setGlobalPrefix('api', { exclude: excludePaths });
  app.useWebSocketAdapter(new WebSocketAdapter(app));

  useSwagger(app, { write: configRepository.isDev() && permitSwaggerWrite });

  if (existsSync(resourcePaths.web.root)) {
    // copied from https://github.com/sveltejs/kit/blob/679b5989fe62e3964b9a73b712d7b41831aa1f07/packages/adapter-node/src/handler.js#L46
    // provides serving of precompressed assets and caching of immutable assets
    app.use(
      sirv(resourcePaths.web.root, {
        etag: true,
        gzip: true,
        brotli: true,
        extensions: [],
        setHeaders: (res, pathname) => {
          if (pathname.startsWith(`/_app/immutable`) && res.statusCode === 200) {
            res.setHeader('cache-control', 'public,max-age=31536000,immutable');
          }
        },
      }),
    );
  }

  app.use(app.get(ssr).ssr(excludePaths));
  app.use(compression());

  const server = await (host ? app.listen(port, host) : app.listen(port));
  server.requestTimeout = 24 * 60 * 60 * 1000;

  // make sure every socket always has an error handler
  server.on('connection', (socket) => {
    socket.on('error', (error) => {
      logger.debug(`Socket error: ${error.message}`);
    });
  });

  logger.log(`${IMMICH_SERVER_START} on ${await app.getUrl()} [v${serverVersion}] [${environment}] `);
}
