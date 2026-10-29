import crypto from 'crypto';
import { SrcCreditModel } from '../../db/models/src-credit.model';
import { eventConsumerService } from '../../services/event-consumer';
import { clock } from '../../services/clock';
import { logger } from '../../logger';
import { NotFoundError, ValidationError } from '../../errors/app-error';

export interface IssueCreditOptions {
  tenantId: string;
  customerId: string;
  unit: 'POINTS' | 'PAISE';
  amount: number;
  reason: string;
  expiresAt: Date | string;
  sourceOrderId?: string;
  occurredAt?: Date | string;
  creditId?: string;
}

export interface RedeemCreditOptions {
  tenantId: string;
  creditId: string;
  amount?: number;
  occurredAt?: Date | string;
}

export interface ExtendExpiryOptions {
  tenantId: string;
  creditId: string;
  expiresAt: Date | string;
  occurredAt?: Date | string;
}

export interface ExpireCreditOptions {
  tenantId: string;
  creditId: string;
  occurredAt?: Date | string;
}

export interface RevokeCreditOptions {
  tenantId: string;
  creditId: string;
  occurredAt?: Date | string;
}

/**
 * DEV-ONLY MockLedger Service.
 * Stand-in for the external ledger owner. Writes src_credits AND emits events
 * through eventConsumerService using producer "ledger".
 *
 * HARD RULE: Production code must NEVER import MockLedger or write src_credits.
 */
export class MockLedgerService {
  async issueCredit(options: IssueCreditOptions) {
    const {
      tenantId,
      customerId,
      unit,
      amount,
      reason,
      sourceOrderId,
    } = options;

    if (amount <= 0) {
      throw new ValidationError('Amount must be positive');
    }

    const creditId = options.creditId || `crd_${crypto.randomUUID().slice(0, 12)}`;
    const expiresAt = new Date(options.expiresAt);
    const occurredAt = options.occurredAt ? new Date(options.occurredAt) : clock.now();
    const type = unit === 'POINTS' ? 'POINTS' : 'CASHBACK';

    const credit = await SrcCreditModel.create({
      creditId,
      tenantId,
      customerId,
      type,
      unit,
      amount,
      originalAmount: amount,
      issuedAt: occurredAt,
      expiresAt,
      status: 'ACTIVE',
      reason,
      sourceOrderId: sourceOrderId || null,
      entityVersion: 1,
    });

    const eventId = `evt_crd_iss_${crypto.randomUUID().slice(0, 10)}`;
    await eventConsumerService.ingestEvent(tenantId, 'ledger', {
      schemaVersion: 1,
      producer: 'ledger',
      eventId,
      type: 'credit.issued',
      entityId: creditId,
      entityVersion: 1,
      customerId,
      occurredAt,
      data: {
        creditId,
        customerId,
        unit,
        amount,
        reason,
        expiresAt: expiresAt.toISOString(),
        sourceOrderId: sourceOrderId || null,
      },
    });

    logger.info({ tenantId, creditId, customerId, amount, reason }, 'MockLedger: Issued credit');
    return credit;
  }

  async redeemCredit(options: RedeemCreditOptions) {
    const { tenantId, creditId, amount } = options;
    const occurredAt = options.occurredAt ? new Date(options.occurredAt) : clock.now();

    const credit = await SrcCreditModel.findOne({ tenantId, creditId });
    if (!credit) {
      throw new NotFoundError(`Credit '${creditId}' not found`);
    }

    const redeemAmount = amount !== undefined ? amount : credit.amount;
    if (redeemAmount <= 0) {
      throw new ValidationError('Redeem amount must be positive');
    }

    const newAmount = Math.max(0, credit.amount - redeemAmount);
    const isFullyRedeemed = newAmount === 0;
    const change = isFullyRedeemed ? 'REDEEMED' : 'PARTIALLY_REDEEMED';

    credit.amount = newAmount;
    if (isFullyRedeemed) {
      credit.status = 'REDEEMED';
    }
    credit.entityVersion = (credit.entityVersion || 1) + 1;
    await credit.save();

    const eventId = `evt_crd_upd_${crypto.randomUUID().slice(0, 10)}`;
    await eventConsumerService.ingestEvent(tenantId, 'ledger', {
      schemaVersion: 1,
      producer: 'ledger',
      eventId,
      type: 'credit.updated',
      entityId: creditId,
      entityVersion: credit.entityVersion,
      customerId: credit.customerId,
      occurredAt,
      data: {
        creditId,
        change,
        redeemedAmount: redeemAmount,
        amountRemaining: newAmount,
        status: credit.status,
      },
    });

    logger.info({ tenantId, creditId, change, newAmount }, 'MockLedger: Redeemed credit');
    return credit;
  }

  async extendExpiry(options: ExtendExpiryOptions) {
    const { tenantId, creditId } = options;
    const newExpiresAt = new Date(options.expiresAt);
    const occurredAt = options.occurredAt ? new Date(options.occurredAt) : clock.now();

    const credit = await SrcCreditModel.findOne({ tenantId, creditId });
    if (!credit) {
      throw new NotFoundError(`Credit '${creditId}' not found`);
    }

    credit.expiresAt = newExpiresAt;
    credit.entityVersion = (credit.entityVersion || 1) + 1;
    await credit.save();

    const eventId = `evt_crd_upd_${crypto.randomUUID().slice(0, 10)}`;
    await eventConsumerService.ingestEvent(tenantId, 'ledger', {
      schemaVersion: 1,
      producer: 'ledger',
      eventId,
      type: 'credit.updated',
      entityId: creditId,
      entityVersion: credit.entityVersion,
      customerId: credit.customerId,
      occurredAt,
      data: {
        creditId,
        change: 'EXPIRY_EXTENDED',
        newExpiresAt: newExpiresAt.toISOString(),
      },
    });

    logger.info({ tenantId, creditId, newExpiresAt }, 'MockLedger: Extended credit expiry');
    return credit;
  }

  async expireCredit(options: ExpireCreditOptions) {
    const { tenantId, creditId } = options;
    const occurredAt = options.occurredAt ? new Date(options.occurredAt) : clock.now();

    const credit = await SrcCreditModel.findOne({ tenantId, creditId });
    if (!credit) {
      throw new NotFoundError(`Credit '${creditId}' not found`);
    }

    credit.status = 'EXPIRED';
    credit.entityVersion = (credit.entityVersion || 1) + 1;
    await credit.save();

    const eventId = `evt_crd_exp_${crypto.randomUUID().slice(0, 10)}`;
    await eventConsumerService.ingestEvent(tenantId, 'ledger', {
      schemaVersion: 1,
      producer: 'ledger',
      eventId,
      type: 'credit.expired',
      entityId: creditId,
      entityVersion: credit.entityVersion,
      customerId: credit.customerId,
      occurredAt,
      data: {
        creditId,
        expiredAmount: credit.amount,
        status: 'EXPIRED',
      },
    });

    logger.info({ tenantId, creditId }, 'MockLedger: Expired credit');
    return credit;
  }

  async revokeCredit(options: RevokeCreditOptions) {
    const { tenantId, creditId } = options;
    const occurredAt = options.occurredAt ? new Date(options.occurredAt) : clock.now();

    const credit = await SrcCreditModel.findOne({ tenantId, creditId });
    if (!credit) {
      throw new NotFoundError(`Credit '${creditId}' not found`);
    }

    credit.status = 'REVOKED';
    credit.entityVersion = (credit.entityVersion || 1) + 1;
    await credit.save();

    const eventId = `evt_crd_upd_${crypto.randomUUID().slice(0, 10)}`;
    await eventConsumerService.ingestEvent(tenantId, 'ledger', {
      schemaVersion: 1,
      producer: 'ledger',
      eventId,
      type: 'credit.updated',
      entityId: creditId,
      entityVersion: credit.entityVersion,
      customerId: credit.customerId,
      occurredAt,
      data: {
        creditId,
        change: 'REVOKED',
        status: 'REVOKED',
      },
    });

    logger.info({ tenantId, creditId }, 'MockLedger: Revoked credit');
    return credit;
  }
}

export const mockLedgerService = new MockLedgerService();
