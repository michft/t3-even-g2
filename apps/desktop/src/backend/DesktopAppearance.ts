import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

export class DesktopAppearancePublishError extends Schema.TaggedError<DesktopAppearancePublishError>()(
  "DesktopAppearancePublishError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to publish the host desktop Appearance canvas.";
  }
}

export class DesktopAppearance extends Context.Service<
  DesktopAppearance,
  {
    readonly publish: (canvas: string) => Effect.Effect<void, DesktopAppearancePublishError>;
  }
>()("@t3tools/desktop/backend/DesktopAppearance") {}

const make = Effect.gen(function* () {
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const httpClient = yield* HttpClient.HttpClient;
  const publications = yield* Semaphore.make(1);

  return {
    publish: (canvas) =>
      publications.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* settings.get).localEnvironmentEnabled) return;
          const primary = yield* pool.primary;
          const config = yield* primary.currentConfig;
          if (Option.isNone(config)) return;
          const bearer = yield* auth.getBearerToken;
          const request = yield* HttpClientRequest.post(
            new URL("/api/desktop/appearance", config.value.httpBaseUrl).href,
          ).pipe(HttpClientRequest.bearerToken(bearer), HttpClientRequest.bodyJson({ canvas }));
          yield* httpClient
            .execute(request)
            .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.asVoid);
        }).pipe(Effect.mapError((cause) => new DesktopAppearancePublishError({ cause }))),
      ),
  } satisfies DesktopAppearance["Service"];
});

export const layer = Layer.effect(DesktopAppearance, make);
