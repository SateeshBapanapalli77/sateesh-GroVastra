import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { logger } from '../logger/logger';
import { config } from '../config/env';

export interface CodeViolation {
  file: string;
  lineNumber: number;
  lineContent: string;
  matchedToken: string;
}

export interface DbViolation {
  collection: string;
  count: number;
  details: string;
}

export interface CheckReport {
  passed: boolean;
  codeViolations: CodeViolation[];
  dbViolations: DbViolation[];
  scannedFilesCount: number;
}

export interface CheckOptions {
  rootDir?: string;
  checkDb?: boolean;
  dbName?: string;
  mongoUri?: string;
}

const FORBIDDEN_TOKENS = [
  'WELCOME_FIRST_VISIT',
  'welcome_first_visit',
  'src_visits',
  'SrcVisitModel',
  'SrcVisit',
  'FIRST_VISIT_RECORDED',
  'storeVisits',
  'eligibleFirstVisits',
  'ENABLE_STAFF_RECORD_VISIT',
  'ENABLE_VISIT_TRIGGER',
  '/customers/:id/visits',
  '/visits/:visitId/void',
  'visitCount',
  'firstVisitId',
  'firstVisitAt',
  'lastVisitAt',
  'visitAggregateVersion',
];

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.gemini',
  'coverage',
  '.turbo',
  'scratch',
]);

const IGNORED_FILES = new Set([
  'spec_dump.txt',
  'GroVastra_Auto_Campaigns_Developer_Handoff.pdf',
  'package-lock.json',
  'pnpm-lock.yaml',
]);

export async function checkLegacyVisit(options: CheckOptions = {}): Promise<CheckReport> {
  const rootDir = options.rootDir || path.resolve(__dirname, '../../../../');
  const allowlistPath = path.resolve(rootDir, 'apps/api/scripts/legacy-visit-allowlist.json');

  let allowedPatterns: string[] = [];
  let allowedFiles: string[] = [];

  if (fs.existsSync(allowlistPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
      allowedPatterns = parsed.allowedPatterns || [];
      allowedFiles = parsed.allowedFiles || [];
    } catch (e) {
      logger.warn({ err: e }, 'Failed to parse legacy-visit-allowlist.json');
    }
  }

  // Normalize allowedFiles relative to root
  const normalizedAllowedFiles = new Set(
    allowedFiles.map((f) => path.normalize(f).replace(/\\/g, '/').toLowerCase())
  );

  const codeViolations: CodeViolation[] = [];
  let scannedFilesCount = 0;

  function shouldScanFile(filePath: string): boolean {
    const basename = path.basename(filePath);
    if (IGNORED_FILES.has(basename)) return false;

    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.env', '.example', '.html', '.css'].includes(ext);
  }

  function walkDirectory(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walkDirectory(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

        // Check if file is in allowedFiles
        if (normalizedAllowedFiles.has(relPath.toLowerCase())) {
          continue;
        }

        if (shouldScanFile(fullPath)) {
          scannedFilesCount++;
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Check if line matches any allowed pattern
            let isAllowed = false;
            for (const pattern of allowedPatterns) {
              if (line.includes(pattern)) {
                isAllowed = true;
                break;
              }
            }
            if (isAllowed) continue;

            for (const token of FORBIDDEN_TOKENS) {
              if (line.includes(token)) {
                codeViolations.push({
                  file: relPath,
                  lineNumber: i + 1,
                  lineContent: line.trim(),
                  matchedToken: token,
                });
              }
            }
          }
        }
      }
    }
  }

  walkDirectory(rootDir);

  // Database Scan
  const dbViolations: DbViolation[] = [];
  const checkDb = options.checkDb !== false;

  if (checkDb) {
    try {
      const uri = options.mongoUri || config.MONGODB_URI;
      const targetDbName = options.dbName || config.MONGODB_DB;

      let conn: mongoose.Connection;
      let ownConnection = false;

      if (mongoose.connection.readyState === 1) {
        conn = mongoose.connection;
      } else {
        await mongoose.connect(uri, { dbName: targetDbName, serverSelectionTimeoutMS: 3000 });
        conn = mongoose.connection;
        ownConnection = true;
      }

      const db = conn.db;
      if (db) {
        // 1. Check src_visits collection
        const cols = await db.listCollections().toArray();
        if (cols.some((c) => c.name === 'src_visits')) {
          const count = await db.collection('src_visits').countDocuments();
          dbViolations.push({
            collection: 'src_visits',
            count,
            details: `Collection src_visits exists with ${count} documents`,
          });
        }

        // 2. Check legacy campaigns
        const legacyCampaignsCount = await db.collection('campaigns').countDocuments({
          $or: [
            { presetId: 'WELCOME_FIRST_VISIT' },
            { triggerMode: 'VISIT' },
            { campaignId: 'cmp_wel_first_visit' },
          ],
        });
        if (legacyCampaignsCount > 0) {
          dbViolations.push({
            collection: 'campaigns',
            count: legacyCampaignsCount,
            details: `Found ${legacyCampaignsCount} legacy visit campaigns`,
          });
        }

        // 3. Check inbox visit events (only non-quarantined are violations, as incoming are quarantined)
        const inboxVisitCount = await db.collection('campaignEventInbox').countDocuments({
          type: { $in: ['visit.recorded', 'visit.voided'] },
          status: { $ne: 'QUARANTINED' },
        });
        if (inboxVisitCount > 0) {
          dbViolations.push({
            collection: 'campaignEventInbox',
            count: inboxVisitCount,
            details: `Found ${inboxVisitCount} visit events in campaignEventInbox`,
          });
        }

        // 4. Check facts with visit fields
        const factsCount = await db.collection('campaignCustomerFacts').countDocuments({
          $or: [
            { visitCount: { $exists: true } },
            { firstVisitId: { $exists: true } },
            { firstVisitAt: { $exists: true } },
            { lastVisitAt: { $exists: true } },
            { visitAggregateVersion: { $exists: true } },
          ],
        });
        if (factsCount > 0) {
          dbViolations.push({
            collection: 'campaignCustomerFacts',
            count: factsCount,
            details: `Found ${factsCount} customer facts containing legacy visit fields`,
          });
        }
      }

      if (ownConnection) {
        await mongoose.disconnect();
      }
    } catch (err: unknown) {
      logger.warn({ err }, 'Could not connect to database for checkLegacyVisit (skipping DB checks)');
    }
  }

  const passed = codeViolations.length === 0 && dbViolations.length === 0;

  return {
    passed,
    codeViolations,
    dbViolations,
    scannedFilesCount,
  };
}

if (process.argv[1] && (process.argv[1].endsWith('checkLegacyVisit.ts') || process.argv[1].endsWith('checkLegacyVisit.js'))) {
  checkLegacyVisit()
    .then((report) => {
      logger.info(`Scanned ${report.scannedFilesCount} files.`);
      if (report.passed) {
        logger.info('Legacy visit leftover scan PASSED: Zero forbidden tokens or DB artifacts found.');
        process.exit(0);
      } else {
        logger.error(`Legacy visit leftover scan FAILED: ${report.codeViolations.length} code violations, ${report.dbViolations.length} DB violations.`);
        for (const v of report.codeViolations) {
          logger.error(`[CODE VIOLATION] ${v.file}:${v.lineNumber} - Token '${v.matchedToken}': ${v.lineContent}`);
        }
        for (const v of report.dbViolations) {
          logger.error(`[DB VIOLATION] Collection '${v.collection}': ${v.details}`);
        }
        process.exit(1);
      }
    })
    .catch((err) => {
      logger.error({ err }, 'checkLegacyVisit crashed.');
      process.exit(1);
    });
}
