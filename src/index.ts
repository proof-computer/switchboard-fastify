import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions
} from "fastify";
import {
  buildSwitchboardChallengeResult,
  createSwitchboardRuntime,
  SWITCHBOARD_CHALLENGE_PATH,
  SWITCHBOARD_STATUS_PATH,
  type SwitchboardChallengeConfig,
  type SwitchboardRuntime,
  type SwitchboardRuntimeOptions
} from "@proofcomputer/switchboard-sdk";

export interface SwitchboardFastifyPluginOptions extends Partial<SwitchboardChallengeConfig> {
  runtime?: SwitchboardRuntime;
  additionalChallengePaths?: string[];
  status?: false | { path?: string; build?: () => Record<string, unknown> | Promise<Record<string, unknown>> };
  health?: false | { path?: string; build?: () => Record<string, unknown> | Promise<Record<string, unknown>> };
}

export interface ServeSwitchboardFastifyOptions {
  runtime?: SwitchboardRuntimeOptions | SwitchboardRuntime;
  host?: string;
  port?: number;
  fastify?: Omit<FastifyServerOptions, "https">;
  mountPlugin?: boolean;
}

export interface SwitchboardFastifyServer {
  runtime: SwitchboardRuntime;
  app: FastifyInstance;
  url: string;
}

export const switchboardFastify: FastifyPluginAsync<SwitchboardFastifyPluginOptions> = async (fastify, options) => {
  const runtime = options.runtime ?? createSwitchboardRuntime();
  for (const path of uniqueRoutePaths([SWITCHBOARD_CHALLENGE_PATH, ...(options.additionalChallengePaths ?? [])])) {
    fastify.get(path, async (request, reply) => {
      const result = buildSwitchboardChallengeResult(challengeConfig(runtime, request, options), {
        nonce: queryValue(request, "nonce"),
        path: requestPath(request),
        userAgent: headerValue(request.headers["user-agent"]),
        remoteAddress: request.ip
      });
      return sendChallengeResult(reply, result);
    });
  }

  if (options.status !== false) {
    const status = options.status ?? {};
    const path = status.path ?? SWITCHBOARD_STATUS_PATH;
    for (const statusPath of uniqueRoutePaths([path, "/status"])) {
      fastify.get(statusPath, async (_request, reply) => {
        reply.header("cache-control", "no-store");
        return {
          ...statusBody(runtime),
          ...(status.build ? await status.build() : {})
        };
      });
    }
  }

  if (options.health !== false) {
    const health = options.health ?? {};
    fastify.get(health.path ?? "/health", async () => ({
      ok: true,
      ...(health.build ? await health.build() : {})
    }));
  }
};

export const proofIngressFastify = switchboardFastify;

export async function serveSwitchboardFastify(
  buildApp: (app: FastifyInstance, runtime: SwitchboardRuntime) => void | Promise<void>,
  options: ServeSwitchboardFastifyOptions = {}
): Promise<SwitchboardFastifyServer> {
  const runtime = isRuntime(options.runtime) ? options.runtime : createSwitchboardRuntime(options.runtime);
  const prepared = await runtime.prepare();
  const app = Fastify({
    ...(options.fastify ?? {}),
    ...(prepared.tlsOptions ? { https: prepared.tlsOptions } : {})
  });
  if (options.mountPlugin !== false) {
    await app.register(switchboardFastify, { runtime });
  }
  await buildApp(app, runtime);
  const host = options.host ?? runtime.configValue("SWITCHBOARD_HOST") ?? runtime.configValue("PROOF_INGRESS_HOST") ?? "127.0.0.1";
  const port = options.port ?? Number(runtime.configValue("PORT") ?? "3000");
  await app.listen({ host, port });
  const protocol = prepared.tlsOptions ? "https" : "http";
  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `${protocol}://${host}:${actualPort}`;
  await runtime.log("server-listening", {
    protocol,
    host,
    port: actualPort,
    certificateHostnames: prepared.certificates.map((certificate) => certificate.hostname)
  });
  await reportReadyAfterListen(runtime, app, { protocol, host, port: actualPort });
  return { runtime, app, url };
}

export const serveProofIngressFastify = serveSwitchboardFastify;

export type ProofIngressFastifyPluginOptions = SwitchboardFastifyPluginOptions;
export type ServeProofIngressFastifyOptions = ServeSwitchboardFastifyOptions;
export type ProofIngressFastifyServer = SwitchboardFastifyServer;

function challengeConfig(
  runtime: SwitchboardRuntime,
  request: FastifyRequest,
  options: SwitchboardFastifyPluginOptions
): SwitchboardChallengeConfig {
  return {
    sessionId: options.sessionId ?? (() => runtime.sessionId()),
    deploymentId: options.deploymentId ?? runtime.deploymentId,
    jobId: options.jobId ?? (() => runtime.jobId()),
    onChallenge: options.onChallenge ?? ((event) => runtime.log("challenge-hit", {
      nonceLength: event.nonce.length,
      userAgent: headerValue(request.headers["user-agent"]),
      remoteAddress: request.ip
    }))
  };
}

function sendChallengeResult(reply: FastifyReply, result: ReturnType<typeof buildSwitchboardChallengeResult>) {
  reply.code(result.statusCode);
  for (const [name, value] of Object.entries(result.headers)) {
    reply.header(name, value);
  }
  return result.body;
}

function statusBody(runtime: SwitchboardRuntime): Record<string, unknown> {
  return {
    ok: true,
    sessionId: runtime.sessionId(),
    jobId: runtime.jobId(),
    deploymentId: runtime.deploymentId,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

function queryValue(request: FastifyRequest, name: string): unknown {
  return typeof request.query === "object" && request.query != null
    ? (request.query as Record<string, unknown>)[name]
    : undefined;
}

function requestPath(request: FastifyRequest): string {
  return new URL(request.url, "http://switchboard.local").pathname;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

function uniqueRoutePaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    out.push(path);
  }
  return out;
}

async function reportReadyAfterListen(
  runtime: SwitchboardRuntime,
  app: FastifyInstance,
  details: { protocol: "http" | "https"; host: string; port: number }
): Promise<void> {
  try {
    await runtime.reportReady(details);
  } catch (error) {
    await runtime.log("ready-report-failed", {
      retrying: runtime.configValue("SWITCHBOARD_READY_REPORT_RETRY") !== "false",
      error: safeError(error)
    }).catch(() => undefined);
    startReadyReportRetry(runtime, app, details);
  }
}

function startReadyReportRetry(
  runtime: SwitchboardRuntime,
  app: FastifyInstance,
  details: { protocol: "http" | "https"; host: string; port: number }
): void {
  if (runtime.configValue("SWITCHBOARD_READY_REPORT_RETRY") === "false") {
    return;
  }
  const intervalMs = Math.max(1_000, numberConfig(runtime, "SWITCHBOARD_READY_REPORT_RETRY_MS", 10_000));
  const maxAttempts = numberConfig(runtime, "SWITCHBOARD_READY_REPORT_MAX_ATTEMPTS", 60);
  let attempts = 0;
  const timer = setInterval(() => {
    if (attempts >= maxAttempts) {
      clearInterval(timer);
      return;
    }
    attempts += 1;
    void runtime.reportReady(details)
      .then(() => {
        clearInterval(timer);
        void runtime.log("ready-report-succeeded", { attempt: attempts }).catch(() => undefined);
      })
      .catch((error) => {
        void runtime.log("ready-report-failed", {
          attempt: attempts,
          retrying: attempts < maxAttempts,
          error: safeError(error)
        }).catch(() => undefined);
      });
  }, intervalMs);
  timer.unref();
  app.server.once("close", () => clearInterval(timer));
}

function numberConfig(runtime: SwitchboardRuntime, name: string, fallback: number): number {
  const value = runtime.configValue(name);
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function isRuntime(value: ServeSwitchboardFastifyOptions["runtime"]): value is SwitchboardRuntime {
  return Boolean(value && typeof (value as SwitchboardRuntime).prepare === "function");
}

export { Fastify };
