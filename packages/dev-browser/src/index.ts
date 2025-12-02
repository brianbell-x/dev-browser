import express, { type Express, type Request, type Response } from "express";
import { chromium, type Browser, type BrowserContext } from "playwright";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
} from "./types";

export type {
  ServeOptions,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
};

export interface DevBrowserServer {
  wsEndpoint: string;
  port: number;
  stop: () => Promise<void>;
}

export async function serve(
  options: ServeOptions = {}
): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const headless = options.headless ?? false;
  const cdpPort = options.cdpPort ?? 9223;

  console.log("Launching browser...");

  // Launch browser with CDP remote debugging enabled
  const browser: Browser = await chromium.launch({
    headless,
    args: [`--remote-debugging-port=${cdpPort}`],
  });
  console.log("Browser launched...");

  // Get the CDP WebSocket endpoint from Chrome's JSON API
  const cdpResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

  // Registry: name -> BrowserContext (server owns all contexts)
  const registry = new Map<string, BrowserContext>();

  // Express server for page management
  const app: Express = express();
  app.use(express.json());

  // GET / - server info
  app.get("/", (_req: Request, res: Response) => {
    const response: ServerInfoResponse = { wsEndpoint };
    res.json(response);
  });

  // GET /pages - list all pages
  app.get("/pages", (_req: Request, res: Response) => {
    const response: ListPagesResponse = {
      pages: Array.from(registry.keys()),
    };
    res.json(response);
  });

  // POST /pages - get or create page
  app.post("/pages", async (req: Request, res: Response) => {
    const body = req.body as GetPageRequest;
    const { name } = body;

    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    // Check if page already exists
    if (!registry.has(name)) {
      // Create new context with init script
      const context = await browser.newContext();
      await context.addInitScript((pageName: string) => {
        (globalThis as any).__devBrowserPageName = pageName;
      }, name);
      await context.newPage();
      registry.set(name, context);
    }

    const response: GetPageResponse = { wsEndpoint, name };
    res.json(response);
  });

  // DELETE /pages/:name - close a page
  app.delete("/pages/:name", async (req: Request, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const context = registry.get(name);

    if (context) {
      await context.close();
      registry.delete(name);
      res.json({ success: true });
      return;
    }

    res.status(404).json({ error: "page not found" });
  });

  // Start the server
  const server = app.listen(port, () => {
    console.log(`HTTP API server running on port ${port}`);
  });

  // Track if cleanup has been called to avoid double cleanup
  let cleaningUp = false;

  // Cleanup function
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;

    console.log("\nShutting down...");
    // Close all contexts
    for (const context of registry.values()) {
      try {
        await context.close();
      } catch {
        // Context might already be closed
      }
    }
    registry.clear();
    // Close browser and HTTP server
    try {
      await browser.close();
    } catch {
      // Browser might already be closed
    }
    server.close();
    console.log("Server stopped.");
  };

  // Synchronous cleanup for forced exits - kills browser process directly
  const syncCleanup = () => {
    if (browser.isConnected()) {
      try {
        // Force kill the browser process
        browser.close();
      } catch {
        // Best effort
      }
    }
  };

  // Signal handlers
  const sigintHandler = async () => {
    await cleanup();
    process.exit(0);
  };
  const sigtermHandler = async () => {
    await cleanup();
    process.exit(0);
  };
  const sighupHandler = async () => {
    await cleanup();
    process.exit(0);
  };
  const uncaughtHandler = async (err: Error) => {
    console.error("Uncaught exception:", err);
    await cleanup();
    process.exit(1);
  };
  const rejectionHandler = async (reason: unknown) => {
    console.error("Unhandled rejection:", reason);
    await cleanup();
    process.exit(1);
  };

  // Register signal handlers
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);
  process.on("SIGHUP", sighupHandler);
  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", rejectionHandler);
  process.on("exit", syncCleanup);

  // Helper to remove all handlers
  const removeHandlers = () => {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
    process.off("SIGHUP", sighupHandler);
    process.off("uncaughtException", uncaughtHandler);
    process.off("unhandledRejection", rejectionHandler);
    process.off("exit", syncCleanup);
  };

  return {
    wsEndpoint,
    port,
    async stop() {
      removeHandlers();
      await cleanup();
    },
  };
}
