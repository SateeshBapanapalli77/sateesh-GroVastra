import { SourceTemplate } from '@grovastra/shared';
import { SrcTemplateModel, ISrcTemplate } from '../db/models/src-template.model';

export interface TemplateFilter {
  category?: string;
  sendable?: boolean;
  source?: string;
}

export interface TemplateSourceAdapter {
  listTemplates(filter?: TemplateFilter): Promise<SourceTemplate[]>;
  getTemplateById(id: string): Promise<SourceTemplate | null>;
  countTemplates(filter?: TemplateFilter): Promise<number>;
}

export class MongoTemplateSourceAdapter implements TemplateSourceAdapter {
  async listTemplates(filter: TemplateFilter = {}): Promise<SourceTemplate[]> {
    const query: Record<string, unknown> = {};

    if (filter.category) {
      query.category = filter.category;
    }
    if (typeof filter.sendable === 'boolean') {
      query.sendable = filter.sendable;
    }
    if (filter.source) {
      query.source = filter.source;
    }

    const docs = await SrcTemplateModel.find(query).sort({ sendable: -1, id: 1 }).lean<ISrcTemplate[]>();

    return docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      language: doc.language,
      category: doc.category,
      status: doc.status,
      bodyText: doc.bodyText,
      variables: doc.variables || [],
      revision: doc.revision,
      sendable: doc.sendable,
      source: doc.source,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }));
  }

  async getTemplateById(id: string): Promise<SourceTemplate | null> {
    const doc = await SrcTemplateModel.findOne({
      $or: [{ id }, { name: id }],
    }).lean<ISrcTemplate | null>();
    if (!doc) return null;

    return {
      id: doc.id,
      name: doc.name,
      language: doc.language,
      category: doc.category,
      status: doc.status,
      bodyText: doc.bodyText,
      variables: doc.variables || [],
      revision: doc.revision,
      sendable: doc.sendable,
      source: doc.source,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  async countTemplates(filter: TemplateFilter = {}): Promise<number> {
    const query: Record<string, unknown> = {};
    if (filter.category) query.category = filter.category;
    if (typeof filter.sendable === 'boolean') query.sendable = filter.sendable;
    if (filter.source) query.source = filter.source;

    return SrcTemplateModel.countDocuments(query);
  }
}

export const mockTemplateSource = new MongoTemplateSourceAdapter();
