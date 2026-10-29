import { AuditLogModel, IAuditLog } from '../db/models/audit-log.model';
import { logger } from '../logger/logger';

export interface AuditEventParams {
  tenantId: string;
  userId?: string;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/**
 * Audit Log Helper
 * Strictly append-only: provides only logEvent() and read operations.
 * Mutation/deletion operations are not implemented and forbidden at the database schema layer.
 */
export class AuditService {
  /**
   * Appends an immutable audit event record.
   */
  public async logEvent(params: AuditEventParams): Promise<IAuditLog> {
    try {
      const [entry] = await AuditLogModel.create([
        {
          tenantId: params.tenantId,
          userId: params.userId,
          action: params.action,
          metadata: params.metadata || {},
          ip: params.ip,
          userAgent: params.userAgent,
          createdAt: new Date(),
        },
      ]);

      logger.info(
        {
          tenantId: params.tenantId,
          userId: params.userId,
          action: params.action,
        },
        'Audit event recorded'
      );

      return entry;
    } catch (err) {
      logger.error(
        { err, tenantId: params.tenantId, action: params.action },
        'Failed to record audit event'
      );
      throw err;
    }
  }

  /**
   * Retrieves audit logs strictly scoped to a tenant in reverse chronological order.
   */
  public async getTenantLogs(
    tenantId: string,
    limit = 50,
    skip = 0
  ): Promise<IAuditLog[]> {
    return (await AuditLogModel.find({ tenantId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()) as any;
  }
}

export const auditService = new AuditService();
