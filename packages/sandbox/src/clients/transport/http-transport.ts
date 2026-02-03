import { BaseTransport } from './base-transport';
import type { TransportConfig, TransportMode } from './types';

/**
 * HTTP transport implementation
 *
 * Uses standard fetch API for communication with the container.
 * HTTP is stateless, so connect/disconnect are no-ops.
 */
export class HttpTransport extends BaseTransport {
  private baseUrl: string;

  constructor(config: TransportConfig) {
    super(config);
    this.baseUrl = config.baseUrl ?? 'http://localhost:3000';
  }

  getMode(): TransportMode {
    return 'http';
  }

  async connect(): Promise<void> {
    // No-op for HTTP - stateless protocol
  }

  disconnect(): void {
    // No-op for HTTP - stateless protocol
  }

  isConnected(): boolean {
    return true; // HTTP is always "connected"
  }

  protected async doFetch(
    path: string,
    options?: RequestInit
  ): Promise<Response> {
    const url = this.buildUrl(path);
    const timeoutMs = this.config.requestTimeoutMs ?? 120000;

    // For stub case, delegate to containerFetch which has its own timeout handling
    if (this.config.stub) {
      return this.config.stub.containerFetch(
        url,
        options || {},
        this.config.port
      );
    }

    // Set up abort controller with timeout for real fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await globalThis.fetch(url, {
        ...options,
        signal: controller.signal
      });
    } catch (error) {
      // Convert AbortError to a more descriptive timeout error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms: ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async fetchStream(
    path: string,
    body?: unknown,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.buildUrl(path);
    const options = this.buildStreamOptions(body, method);
    const startTime = Date.now();

    // Debug log stream request start
    if (this.debug) {
      this.logger.debug(`HTTP ${method} ${path} stream started`);
    }

    let response: Response;
    if (this.config.stub) {
      response = await this.config.stub.containerFetch(
        url,
        options,
        this.config.port
      );
    } else {
      response = await globalThis.fetch(url, options);
    }

    if (!response.ok) {
      const errorBody = await response.text();

      // Debug log stream error
      if (this.debug) {
        const duration = Date.now() - startTime;
        this.logger.debug(
          `HTTP ${method} ${path} stream failed (${duration}ms) status=${response.status}`
        );
      }

      throw new Error(`HTTP error! status: ${response.status} - ${errorBody}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    // Debug log stream response
    if (this.debug) {
      const duration = Date.now() - startTime;
      this.logger.debug(
        `HTTP ${method} ${path} stream connected (${duration}ms) status=${response.status}`
      );
    }

    return response.body;
  }

  private buildUrl(path: string): string {
    if (this.config.stub) {
      return `http://localhost:${this.config.port}${path}`;
    }
    return `${this.baseUrl}${path}`;
  }

  private buildStreamOptions(
    body: unknown,
    method: 'GET' | 'POST'
  ): RequestInit {
    return {
      method,
      headers:
        body && method === 'POST'
          ? { 'Content-Type': 'application/json' }
          : undefined,
      body: body && method === 'POST' ? JSON.stringify(body) : undefined
    };
  }
}
