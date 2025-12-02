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

  // Cleanup function
  const cleanup = async () => {
    console.log("\nShutting down...");
    // Close all contexts
    for (const context of registry.values()) {
      await context.close();
    }
    registry.clear();
    // Close browser and HTTP server
    await browser.close();
    server.close();
    console.log("Server stopped.");
    process.exit(0);
  };

  // Register signal handlers
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  return {
    wsEndpoint,
    port,
    async stop() {
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      process.off("SIGHUP", cleanup);
      // Close all contexts
      for (const context of registry.values()) {
        await context.close();
      }
      registry.clear();
      await browser.close();
      server.close();
    },
  };
}
