import {
  ICampaignDeliveryIntent,
  CampaignEnrollmentModel,
  CampaignExecutionModel,
} from '../../db/models';
import { logger } from '../../logger';
import { config } from '../../config/env';
import { sendCampaignStep } from '../../adapters/whatsapp-delivery';

export interface DispatchResult {
  success: boolean;
  mode: 'dry' | 'meta';
  status: string;
  providerMessageId?: string | null;
  error?: string | null;
}

export interface IDispatchPort {
  dispatch(intent: ICampaignDeliveryIntent): Promise<DispatchResult>;
}

export class DryDispatchPort implements IDispatchPort {
  async dispatch(intent: ICampaignDeliveryIntent): Promise<DispatchResult> {
    logger.info(
      {
        deliveryIntentId: intent.deliveryIntentId,
        executionId: intent.executionId,
        templateId: intent.templateRef?.id,
        maskedRecipient: intent.maskedRecipient,
        mode: 'dry',
      },
      'DryDispatchPort: intent frozen with PREPARED_DRY. Zero provider calls made (DISPATCH_MODE=dry).'
    );

    return {
      success: true,
      mode: 'dry',
      status: 'PREPARED_DRY',
    };
  }
}

export class MetaDispatchPort implements IDispatchPort {
  async dispatch(intent: ICampaignDeliveryIntent): Promise<DispatchResult> {
    const [enrollment, execution] = await Promise.all([
      CampaignEnrollmentModel.findOne({ tenantId: intent.tenantId, enrollmentId: intent.enrollmentId }).lean(),
      CampaignExecutionModel.findOne({ tenantId: intent.tenantId, executionId: intent.executionId }).lean(),
    ]);

    const customerId = (enrollment as any)?.customerId || '';
    const expiresAt = (execution as any)?.expiresAt || new Date(Date.now() + 86400000);

    const result = await sendCampaignStep({
      executionId: intent.executionId,
      deliveryKey: intent.deliveryKey,
      connectionId: intent.connectionId,
      customerId,
      recipientVersion: intent.recipientVersion,
      template: {
        id: intent.templateRef.id,
        revision: intent.templateRef.revision,
        language: intent.templateRef.language,
      },
      parameters: intent.parameters,
      expiresAt,
      tenantId: intent.tenantId,
      attemptId: intent.attemptId,
    });

    return {
      success: result.success,
      mode: 'meta',
      status: result.state,
      providerMessageId: result.providerMessageId,
      error: result.reason || (result.error ? JSON.stringify(result.error) : null),
    };
  }
}

// Active dispatch port reference (null by default so it dynamically respects DISPATCH_MODE)
let customDispatchPort: IDispatchPort | null = null;

export function getDispatchPort(): IDispatchPort {
  if (customDispatchPort) {
    return customDispatchPort;
  }
  const mode = (process.env.DISPATCH_MODE || config.DISPATCH_MODE || 'dry').toLowerCase();
  return mode === 'meta' ? new MetaDispatchPort() : new DryDispatchPort();
}

export function setDispatchPort(port: IDispatchPort): void {
  customDispatchPort = port;
}

export function resetDispatchPort(): void {
  customDispatchPort = null;
}
