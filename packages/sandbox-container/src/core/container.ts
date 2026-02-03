import type { Logger } from '@repo/shared';
import { createLogger, GitLogger } from '@repo/shared';
import { ExecuteHandler } from '../handlers/execute-handler';
import { FileHandler } from '../handlers/file-handler';
import { GitHandler } from '../handlers/git-handler';
import { InterpreterHandler } from '../handlers/interpreter-handler';
import { MiscHandler } from '../handlers/misc-handler';
import { PortHandler } from '../handlers/port-handler';
import { ProcessHandler } from '../handlers/process-handler';
import { SessionHandler } from '../handlers/session-handler';
import { SnapshotHandler } from '../handlers/snapshot-handler';
import { CorsMiddleware } from '../middleware/cors';
import { LoggingMiddleware } from '../middleware/logging';
import { SecurityServiceAdapter } from '../security/security-adapter';
import { SecurityService } from '../security/security-service';
import { FileService } from '../services/file-service.js';
import { GitService } from '../services/git-service.js';
import { InterpreterService } from '../services/interpreter-service.js';
import { InMemoryPortStore, PortService } from '../services/port-service.js';
import { ProcessService } from '../services/process-service.js';
import { ProcessStore } from '../services/process-store.js';
import { R2UploadService } from '../services/r2-upload-service.js';
import { SessionManager } from '../services/session-manager.js';
import { SnapshotService } from '../services/snapshot-service.js';

export interface Dependencies {
  // Services
  processService: ProcessService;
  fileService: FileService;
  portService: PortService;
  gitService: GitService;
  interpreterService: InterpreterService;
  snapshotService: SnapshotService;
  r2UploadService: R2UploadService;

  // Infrastructure
  logger: Logger;
  security: SecurityService;

  // Handlers
  executeHandler: ExecuteHandler;
  fileHandler: FileHandler;
  processHandler: ProcessHandler;
  portHandler: PortHandler;
  gitHandler: GitHandler;
  interpreterHandler: InterpreterHandler;
  sessionHandler: SessionHandler;
  miscHandler: MiscHandler;
  snapshotHandler: SnapshotHandler;

  // Middleware
  corsMiddleware: CorsMiddleware;
  loggingMiddleware: LoggingMiddleware;
}

export class Container {
  private dependencies: Partial<Dependencies> = {};
  private initialized = false;

  get<T extends keyof Dependencies>(key: T): Dependencies[T] {
    if (!this.initialized) {
      throw new Error('Container not initialized. Call initialize() first.');
    }

    const dependency = this.dependencies[key];
    if (!dependency) {
      throw new Error(
        `Dependency '${key}' not found. Make sure to initialize the container.`
      );
    }

    // Safe cast because we know the container is initialized and dependency exists
    return dependency as Dependencies[T];
  }

  set<T extends keyof Dependencies>(
    key: T,
    implementation: Dependencies[T]
  ): void {
    this.dependencies[key] = implementation;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize infrastructure
    const logger = createLogger({ component: 'container' });
    const security = new SecurityService(logger);
    const securityAdapter = new SecurityServiceAdapter(security);

    // Initialize stores
    const processStore = new ProcessStore(logger);
    const portStore = new InMemoryPortStore();

    // Initialize SessionManager
    const sessionManager = new SessionManager(logger);

    // Create git-specific logger that automatically sanitizes credentials
    const gitLogger = new GitLogger(logger);

    // Initialize services
    const processService = new ProcessService(
      processStore,
      logger,
      sessionManager
    );
    const fileService = new FileService(
      securityAdapter,
      logger,
      sessionManager
    );
    const portService = new PortService(portStore, securityAdapter, logger);
    const gitService = new GitService(
      securityAdapter,
      gitLogger,
      sessionManager
    );
    const interpreterService = new InterpreterService(logger);
    const snapshotService = new SnapshotService(securityAdapter, logger);
    const r2UploadService = new R2UploadService(sessionManager, logger);

    // Initialize handlers
    const sessionHandler = new SessionHandler(sessionManager, logger);
    const executeHandler = new ExecuteHandler(processService, logger);
    const fileHandler = new FileHandler(fileService, logger);
    const processHandler = new ProcessHandler(processService, logger);
    const portHandler = new PortHandler(portService, processService, logger);
    const gitHandler = new GitHandler(gitService, gitLogger);
    const interpreterHandler = new InterpreterHandler(
      interpreterService,
      logger
    );
    const miscHandler = new MiscHandler(logger);
    const snapshotHandler = new SnapshotHandler(snapshotService, logger);

    // Initialize middleware
    const corsMiddleware = new CorsMiddleware();
    const loggingMiddleware = new LoggingMiddleware(logger);

    // Store all dependencies
    this.dependencies = {
      // Services
      processService,
      fileService,
      portService,
      gitService,
      interpreterService,
      snapshotService,
      r2UploadService,

      // Infrastructure
      logger,
      security,

      // Handlers
      executeHandler,
      fileHandler,
      processHandler,
      portHandler,
      gitHandler,
      interpreterHandler,
      sessionHandler,
      miscHandler,
      snapshotHandler,

      // Middleware
      corsMiddleware,
      loggingMiddleware
    };

    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
