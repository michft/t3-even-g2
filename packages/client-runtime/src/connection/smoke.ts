import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { issueRemoteWebSocketTicket } from "../authorization/remote.ts";
import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";
import { BearerConnectionTarget } from "./model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { deriveWsBaseUrl } from "../environment/endpoint.ts";
import { make as makeRpcSessionFactory } from "../rpc/session.ts";

/** Accept origins only: credentials and tickets must never travel to a separate socket host. */
export function validateSmokeOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Smoke targets require plain HTTP(S) origins without credentials or parameters.",
    );
  return url.origin;
}

export class SmokeFailure extends Schema.TaggedError<SmokeFailure>()("SmokeFailure", {
  stage: Schema.Literals(["descriptor", "permissions", "ticket", "config"]),
  schemaRejected: Schema.Boolean,
}) {}
const decodeSessionGrants = Schema.decodeUnknownEffect(
  Schema.Struct({
    authenticated: Schema.Boolean,
    scopes: Schema.optionalKey(Schema.Array(Schema.String)),
    permissions: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

/** Exercise the mobile client's real initial config subscription, including defect failures. */
export const checkServerConnection = Effect.fn("deployment.checkServerConnection")(function* (
  target: { readonly name: string; readonly environmentId: string; readonly httpBaseUrl: string },
  bearerToken: string,
) {
  let stage: SmokeFailure["stage"] = "descriptor";
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const httpBaseUrl = validateSmokeOrigin(target.httpBaseUrl);
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl });
      if (descriptor.environmentId !== target.environmentId) return yield* Effect.fail("identity");
      const incompatible = orchestrationProtocolCompatibilityError(descriptor);
      if (incompatible !== null) return yield* incompatible;
      stage = "permissions";
      // The normal client decoder drops unknown grants; a read-only gate must retain them.
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.get(new URL("/api/auth/session", httpBaseUrl).toString(), {
        headers: { authorization: `Bearer ${bearerToken}` },
      });
      if (response.status !== 200) return yield* Effect.fail("session");
      const auth = yield* response.json.pipe(Effect.flatMap(decodeSessionGrants));
      const grants = auth.permissions ?? auth.scopes ?? [];
      if (!auth.authenticated || grants.length !== 1 || grants[0] !== "orchestration:read") {
        return yield* Effect.fail("A dedicated orchestration:read session is required.");
      }
      stage = "ticket";
      const issued = yield* issueRemoteWebSocketTicket({ httpBaseUrl, bearerToken });
      const socketUrl = new URL("/ws", deriveWsBaseUrl(httpBaseUrl));
      socketUrl.searchParams.set("wsTicket", issued.ticket);
      stage = "config";
      const factory = yield* makeRpcSessionFactory({
        usageLimitSources: true,
        usageLimitsCommand: true,
      });
      const session = yield* factory.connect({
        environmentId: descriptor.environmentId,
        label: target.name,
        httpBaseUrl,
        socketUrl: appendOrchestrationProtocol(socketUrl.toString()),
        httpAuthorization: null,
        target: new BearerConnectionTarget({
          environmentId: descriptor.environmentId,
          label: target.name,
          connectionId: `smoke:${target.name}`,
        }),
      });
      yield* session.ready;
    }).pipe(
      Effect.timeout("40 seconds"),
      Effect.catchCause((cause) =>
        Effect.fail(
          new SmokeFailure({
            stage,
            schemaRejected: cause.reasons.some((reason) =>
              Schema.isSchemaError(
                Cause.isDieReason(reason)
                  ? reason.defect
                  : Cause.isFailReason(reason)
                    ? reason.error
                    : undefined,
              ),
            ),
          }),
        ),
      ),
    ),
  );
});
