import { FileScanStore } from "./fileStore.js";
import { FileSourceStore } from "./sourceStore.js";
import { FileAuditLog } from "./auditLog.js";
import { FileMetricStore } from "./fileMetricStore.js";
import { FileCatalogStore } from "./fileCatalogStore.js";
import { FileReportStore } from "./fileReportStore.js";
import type { ReportStore, ScanStore } from "./store.js";
import type { SourceStore } from "./sourceStore.js";
import type { AuditLog } from "./auditLog.js";
import type { MetricSeriesStore } from "./metricStore.js";
import type { CatalogStore } from "./catalogStore.js";
import { mongoStoreEnabled } from "./mongo/client.js";
import { MongoSourceStore } from "./mongo/mongoSourceStore.js";
import { MongoScanStore } from "./mongo/mongoScanStore.js";
import { MongoAuditLog } from "./mongo/mongoAuditLog.js";
import { MongoMetricStore } from "./mongo/mongoMetricStore.js";
import { MongoCatalogStore } from "./mongo/mongoCatalogStore.js";
import { MongoReportStore } from "./mongo/mongoReportStore.js";

/**
 * Selects the persistence backend. If a MongoDB store URI is configured
 * (PS_AGENT_MONGO_URI or MDB_MCP_CONNECTION_STRING), everything is stored in
 * MongoDB (collections: sources, scans, audit, metric_series in the `ps_agent`
 * db). Otherwise it falls back to the local file stores.
 */
export interface Stores {
  sources: SourceStore;
  scans: ScanStore;
  audit: AuditLog;
  metrics: MetricSeriesStore;
  catalog: CatalogStore;
  reports: ReportStore;
  backend: "mongodb" | "file";
}

export function createStores(): Stores {
  if (mongoStoreEnabled()) {
    return {
      sources: new MongoSourceStore(),
      scans: new MongoScanStore(),
      audit: new MongoAuditLog(),
      metrics: new MongoMetricStore(),
      catalog: new MongoCatalogStore(),
      reports: new MongoReportStore(),
      backend: "mongodb",
    };
  }
  return {
    sources: new FileSourceStore(),
    scans: new FileScanStore(),
    audit: new FileAuditLog(),
    metrics: new FileMetricStore(),
    catalog: new FileCatalogStore(),
    reports: new FileReportStore(),
    backend: "file",
  };
}
