import {
  SrcAlterationModel,
  ISrcAlteration,
  AlterationStage,
  AlterationMilestoneRecord,
} from '../db/models/src-alteration.model';
import { ForbiddenError } from '../errors/app-error';

export interface SourceAlteration {
  jobId: string;
  tenantId: string;
  orderId: string;
  customerId: string;
  branchId: string;
  garmentDescription: string;
  currentStage: AlterationStage | string;
  milestones: AlterationMilestoneRecord[];
  trialDate?: Date | null;
  readyDate?: Date | null;
  notes?: string | null;
  entityVersion: number;
}

export function toSourceAlteration(doc: ISrcAlteration): SourceAlteration {
  return {
    jobId: doc.jobId,
    tenantId: doc.tenantId,
    orderId: doc.orderId,
    customerId: doc.customerId,
    branchId: doc.branchId,
    garmentDescription: doc.garmentDescription,
    currentStage: doc.currentStage,
    milestones: doc.milestones || [],
    trialDate: doc.trialDate,
    readyDate: doc.readyDate,
    notes: doc.notes,
    entityVersion: doc.entityVersion || 1,
  };
}

export interface AlterationSource {
  getAlteration(tenantId: string, jobId: string): Promise<SourceAlteration | null>;
  listActiveAlterations(tenantId: string): Promise<SourceAlteration[]>;
}

export class MockAlterationSource implements AlterationSource {
  private validateTenant(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new ForbiddenError('Tenant ID is required for AlterationSource operations');
    }
  }

  async getAlteration(tenantId: string, jobId: string): Promise<SourceAlteration | null> {
    this.validateTenant(tenantId);
    const doc = await SrcAlterationModel.findOne({ tenantId, jobId }).lean();
    return doc ? toSourceAlteration(doc as unknown as ISrcAlteration) : null;
  }

  async listActiveAlterations(tenantId: string): Promise<SourceAlteration[]> {
    this.validateTenant(tenantId);
    const docs = await SrcAlterationModel.find({
      tenantId,
      currentStage: { $nin: ['COMPLETED', 'CANCELLED'] },
    })
      .sort({ updatedAt: -1 })
      .lean();
    return docs.map((d) => toSourceAlteration(d as unknown as ISrcAlteration));
  }
}

export const mockAlterationSource = new MockAlterationSource();
