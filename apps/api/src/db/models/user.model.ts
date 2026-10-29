import mongoose, { Document, Schema } from 'mongoose';
import { UserRole, ROLES } from '@grovastra/shared';

export interface IUser extends Document {
  tenantId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  branchIds: string[];
  name?: string;
  status: string;
  seedGroup?: string | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: [ROLES.OWNER, ROLES.ADMIN, ROLES.STAFF],
      required: true,
      default: ROLES.STAFF,
      index: true,
    },
    branchIds: {
      type: [String],
      default: [],
    },
    name: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      default: 'active',
      trim: true,
    },
    seedGroup: {
      type: String,
      default: 'core',
    },
    source: {
      type: String,
      default: 'MOCK',
    },
  },
  {
    timestamps: true,
    collection: 'users',
  }
);

// Compound unique index ensuring uniqueness per tenant
UserSchema.index({ tenantId: 1, email: 1 }, { unique: true });

export const UserModel = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
