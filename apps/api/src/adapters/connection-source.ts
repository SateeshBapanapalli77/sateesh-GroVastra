import { SourceConnection } from '@grovastra/shared';
import { SrcConnectionModel, ISrcConnection } from '../db/models/src-connection.model';

export interface ConnectionSourceAdapter {
  getConnection(tenantId: string): Promise<SourceConnection | null>;
}

export class MongoConnectionSourceAdapter implements ConnectionSourceAdapter {
  async getConnection(tenantId: string): Promise<SourceConnection | null> {
    const doc = await SrcConnectionModel.findOne({ tenantId }).lean<ISrcConnection | null>();
    if (!doc) return null;

    return {
      id: doc.id,
      tenantId: doc.tenantId,
      phoneNumberId: doc.phoneNumberId,
      wabaId: doc.wabaId,
      secretRef: doc.secretRef,
      graphApiVersion: doc.graphApiVersion,
      status: doc.status,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}

export const mockConnectionSource = new MongoConnectionSourceAdapter();
