import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Socket from "effect/socket/Socket";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";

import { checkServerConnection, validateSmokeOrigin } from "./server-connection-smoke.ts";

const target = {
  name: "test-server",
  environmentId: "environment-1",
  httpBaseUrl: "https://server.example.test",
  bearerTokenEnv: "T3CODE_SMOKE_TOKEN_TEST_SERVER",
};
const auth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
};
const descriptor = {
  environmentId: target.environmentId,
  label: "Test server",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  orchestrationProtocolVersion: 2,
  capabilities: {},
};

class ConfigSocket extends EventTarget {
  readyState = 0;
  closed = false;
  readonly url: string;
  readonly compactIdleThreads: unknown;

  constructor(url: string, compactIdleThreads: unknown) {
    super();
    this.url = url;
    this.compactIdleThreads = compactIdleThreads;
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string) {
    const request = JSON.parse(data);
    expect(request.tag).toBe("subscribeServerConfig");
    expect(request.payload).toEqual({ usageLimitSources: true, usageLimitsCommand: true });
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          _tag: "Chunk",
          requestId: request.id,
          values: [
            {
              version: 1,
              type: "snapshot",
              config: {
                environment: descriptor,
                auth,
                cwd: "/tmp/workspace",
                keybindingsConfigPath: "/tmp/keybindings.json",
                keybindings: [],
                issues: [],
                providers: [],
                availableEditors: [],
                observability: {
                  logsDirectoryPath: "/tmp/logs",
                  localTracingEnabled: false,
                  otlpTracesEnabled: false,
                  otlpMetricsEnabled: false,
                  otlpLogsEnabled: false,
                },
                settings: { compactIdleThreads: this.compactIdleThreads },
              },
            },
          ],
        }),
      }),
    );
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }
}

function fixture(
  compactIdleThreads: unknown,
  scopes = ["orchestration:read"],
  permissions?: string[],
) {
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const sockets: ConfigSocket[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    requests.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const body =
      url.pathname === "/.well-known/t3/environment"
        ? descriptor
        : url.pathname === "/api/auth/session"
          ? { authenticated: true, auth, scopes, ...(permissions ? { permissions } : {}) }
          : { ticket: "test-ticket", expiresAt: "2030-01-01T00:00:00Z" };
    return Response.json(body);
  };
  const layer = Layer.mergeAll(
    layerRemoteHttpClient(fetch),
    Layer.succeed(Socket.WebSocketConstructor, (url) => {
      const socket = new ConfigSocket(url, compactIdleThreads);
      sockets.push(socket);
      // The fixture implements the WebSocket protocol surface consumed by Effect.
      return socket as unknown as globalThis.WebSocket;
    }),
    Logger.layer([]),
  );
  return { layer, requests, sockets };
}

it.effect("requires a decoded config snapshot and closes its read-only session", () =>
  Effect.gen(function* () {
    const test = fixture(false);
    yield* checkServerConnection(target, "private-token").pipe(Effect.provide(test.layer));
    expect(test.requests.map((request) => request.path)).toEqual([
      "/.well-known/t3/environment",
      "/api/auth/session",
      "/api/auth/websocket-ticket",
    ]);
    expect(test.sockets).toHaveLength(1);
    expect(test.sockets[0]?.closed).toBe(true);
    expect(new URL(test.sockets[0]!.url).searchParams.get("wsTicket")).toBe("test-ticket");
  }),
);

it.effect.each([true, false, "onReturn", "beforeCacheExpires", "off"])(
  "accepts supported compaction setting %s through real config decoding",
  (mode) =>
    Effect.gen(function* () {
      const test = fixture(mode);
      yield* checkServerConnection(target, "private-token").pipe(Effect.provide(test.layer));
      expect(test.sockets[0]?.closed).toBe(true);
    }),
);

it.effect("rejects malformed config after successful HTTP and socket open", () =>
  Effect.gen(function* () {
    const test = fixture("invalid-compaction-mode");
    const failure = yield* checkServerConnection(target, "private-token").pipe(
      Effect.provide(test.layer),
      Effect.flip,
    );
    expect(failure).toMatchObject({ stage: "config", schemaRejected: true });
    expect(test.sockets[0]?.closed).toBe(true);
  }),
);

it.effect("pins identity before sending credentials", () =>
  Effect.gen(function* () {
    const test = fixture(false);
    const failure = yield* checkServerConnection(
      { ...target, environmentId: "wrong-server" },
      "private-token",
    ).pipe(Effect.provide(test.layer), Effect.flip);
    expect(failure.stage).toBe("descriptor");
    expect(test.requests).toEqual([{ path: "/.well-known/t3/environment", authorization: null }]);
    expect(test.sockets).toEqual([]);
  }),
);

it.effect("rejects a writable credential before requesting a WebSocket ticket", () =>
  Effect.gen(function* () {
    const test = fixture(false, ["orchestration:read", "settings:write"]);
    const failure = yield* checkServerConnection(target, "private-token").pipe(
      Effect.provide(test.layer),
      Effect.flip,
    );
    expect(failure.stage).toBe("permissions");
    expect(test.requests.map((request) => request.path)).toEqual([
      "/.well-known/t3/environment",
      "/api/auth/session",
    ]);
    expect(test.sockets).toEqual([]);
  }),
);

it.effect("rejects unknown grants before the forward-compatible decoder can drop them", () =>
  Effect.gen(function* () {
    const test = fixture(
      false,
      ["orchestration:read"],
      ["orchestration:read", "new-capability:write"],
    );
    const failure = yield* checkServerConnection(target, "private-token").pipe(
      Effect.provide(test.layer),
      Effect.flip,
    );
    expect(failure.stage).toBe("permissions");
    expect(test.sockets).toEqual([]);
  }),
);

it("rejects credential-bearing origins and separate socket paths", () => {
  for (const value of [
    "https://user:secret@server.test",
    "https://server.test/?token=secret",
    "https://server.test/ws",
    "file:///secret",
  ]) {
    expect(() => validateSmokeOrigin(value)).toThrow();
  }
});
