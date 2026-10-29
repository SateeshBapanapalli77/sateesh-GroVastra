import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { requestIdMiddleware } from './middleware/request-id';
import { errorHandler } from './middleware/error-handler';
import { healthRouter } from './routes/health';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { tenantRouter } from './routes/tenant';
import { integrationRouter } from './routes/integration';
import { campaignSettingsRouter } from './routes/campaign-settings';
import { campaignRouter } from './routes/campaigns';
import { enrollmentRouter } from './routes/enrollments';
import { campaignEventsRouter } from './routes/campaign-events';
import { webhookRouter } from './routes/webhook';
import { monitoringRouter } from './routes/monitoring';
import { welcomeRouter } from './presets/welcome/routes';
import { firstToSecondPurchaseRouter } from './presets/firstToSecondPurchase/routes';
import { mockLedgerRouter } from './dev/mockLedger/routes';
import { templateMappingRouter } from './routes/template-mapping';
import { destinationRouter } from './routes/destinations';
import { occasionsRouter } from './routes/occasions';
import { devMockCrmRouter } from './routes/dev-mock-crm';
import { unresolvedEnquiryRouter } from './presets/unresolvedEnquiry/routes';
import { completeOutfitRouter } from './presets/completeOutfit/routes';
import { requestedItemAvailableRouter } from './presets/requestedItemAvailable/routes';
import { matchingCollectionRouter } from './presets/matchingCollection/routes';
import { selectedStockPromotionRouter } from './presets/selectedStockPromotion/routes';
import { mockEnquiryDevRouter } from './dev/mockEnquiryDevRoutes';
import { mockProductDevRouter } from './dev/mockProductDevRoutes';
import { mockRequestDevRouter } from './dev/mockRequestDevRoutes';
import { NotFoundError } from './errors/app-error';

export function createApp(): express.Application {
  const app = express();

  // Basic security and parsing
  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());

  // Attach Request ID and contextual child logger
  app.use(requestIdMiddleware);

  // Request logger
  app.use((req, res, next) => {
    req.log.info({ method: req.method, path: req.path }, 'Incoming request');
    next();
  });

  // Mount webhooks router BEFORE express.json() to capture raw bytes for signature verification
  app.use(webhookRouter);

  // Parse JSON for remaining API routes
  app.use(express.json());

  // Mount routes
  app.use(healthRouter);
  app.use('/admin', adminRouter);
  app.use(authRouter);
  app.use(tenantRouter);
  app.use(integrationRouter);
  app.use(campaignSettingsRouter);
  app.use(campaignRouter);
  app.use(enrollmentRouter);
  app.use(campaignEventsRouter);
  app.use(monitoringRouter);
  app.use(welcomeRouter);
  app.use('/api/v1', welcomeRouter);
  app.use(firstToSecondPurchaseRouter);
  app.use('/api/v1', firstToSecondPurchaseRouter);
  app.use(mockLedgerRouter);
  app.use('/api/v1', mockLedgerRouter);
  app.use(templateMappingRouter);
  app.use('/api/v1', templateMappingRouter);
  app.use(destinationRouter);
  app.use('/api/v1', destinationRouter);
  app.use(occasionsRouter);
  app.use('/api/v1', occasionsRouter);
  app.use(devMockCrmRouter);
  app.use('/api/v1', devMockCrmRouter);
  app.use(unresolvedEnquiryRouter);
  app.use('/api/v1', unresolvedEnquiryRouter);
  app.use(completeOutfitRouter);
  app.use('/api/v1', completeOutfitRouter);
  app.use(requestedItemAvailableRouter);
  app.use('/api/v1', requestedItemAvailableRouter);
  app.use(matchingCollectionRouter);
  app.use('/api/v1', matchingCollectionRouter);
  app.use(selectedStockPromotionRouter);
  app.use('/api/v1', selectedStockPromotionRouter);
  app.use(mockEnquiryDevRouter);
  app.use('/api/v1', mockEnquiryDevRouter);
  app.use(mockProductDevRouter);
  app.use('/api/v1', mockProductDevRouter);
  app.use(mockRequestDevRouter);
  app.use('/api/v1', mockRequestDevRouter);

  // 404 Handler for undefined routes
  app.use((req, res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  });


  // Global Error Handler
  app.use(errorHandler);

  return app;
}

export const app = createApp();
