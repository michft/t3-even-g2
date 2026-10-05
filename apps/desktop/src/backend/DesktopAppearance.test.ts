import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { DesktopAppearancePublication } from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopAppearance from "./DesktopAppearance.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

const decodePublicationJson = Schema.decodeSync(
  Schema.fromJsonString(DesktopAppearancePublication),
);

const primary: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("Host"),
  start: Effect.void,
  stop: () => Effect.void,
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
  currentConfig: Effect.succeedSome({
    executablePath: "/electron",
    entryPath: "/server/bin.mjs",
    args: [],
    cwd: "/server",
    env: {},
    extendEnv: false,
    bootstrap: {
      mode: "desktop",
      noBrowser: true,
      port: 3773,
      host: "127.0.0.1",
      desktopBootstrapToken: "desktop-bootstrap-token",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    },
    bootstrapDelivery: "stdin",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    captureOutput: true,
    preflightFailure: Option.none(),
  }),
};

const testLayer = (
  request: (
    input: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
  localEnvironmentEnabled = true,
) =>
  DesktopAppearance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          localEnvironmentEnabled,
        }),
        DesktopBackendPool.layerTest([primary]),
        Layer.succeed(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.succeed("desktop-session"),
        }),
        Layer.succeed(HttpClient.HttpClient, HttpClient.make(request)),
      ),
    ),
  );

describe("host Appearance publication", () => {
  it.effect("publishes only to the owning primary backend with desktop bearer auth", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
      yield* Effect.gen(function* () {
        const appearance = yield* DesktopAppearance.DesktopAppearance;
        yield* appearance.publish("#123456");
      }).pipe(
        Effect.provide(
          testLayer((request) =>
            Ref.update(requests, (current) => [...current, request]).pipe(
              Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))),
            ),
          ),
        ),
      );
      const [request] = yield* Ref.get(requests);
      assert.isDefined(request);
      assert.equal(request!.url, "http://127.0.0.1:3773/api/desktop/appearance");
      assert.equal(request!.headers.authorization, "Bearer desktop-session");
      assert.equal(request!.method, "POST");
      assert.equal(request!.body._tag, "Uint8Array");
      if (request!.body._tag === "Uint8Array") {
        assert.deepEqual(decodePublicationJson(new TextDecoder().decode(request!.body.body)), {
          canvas: "#123456",
        });
      }
    }),
  );

  it.effect("leaves a desktop without its local environment alone", () =>
    Effect.gen(function* () {
      const appearance = yield* DesktopAppearance.DesktopAppearance;
      yield* appearance.publish("#123456");
    }).pipe(Effect.provide(testLayer(() => Effect.die("Unexpected publication"), false))),
  );

  it.effect("serializes publications so an older request cannot overwrite a newer canvas", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const requestCount = yield* Ref.make(0);
      const first = yield* Effect.gen(function* () {
        const appearance = yield* DesktopAppearance.DesktopAppearance;
        const initial = yield* appearance.publish("#123456").pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        const newest = yield* appearance
          .publish("#abcdef")
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.equal(yield* Ref.get(requestCount), 1);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(initial);
        yield* Fiber.join(newest);
        return yield* Ref.get(requestCount);
      }).pipe(
        Effect.provide(
          testLayer((request) =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(requestCount, (value) => value + 1);
              if (count === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
              return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
            }),
          ),
        ),
      );
      assert.equal(first, 2);
    }),
  );
});
