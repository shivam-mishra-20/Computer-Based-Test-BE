# Automated mobile app builds

An administrator opens an organization in the console, chooses APK or AAB,
presses **Build App**, and downloads a file. Nothing else. No terminal, no EAS
CLI, no config file to edit, no images to copy.

This document is for whoever sets that up and whoever debugs it. The
administrator does not need it.

## What happens when the button is pressed

```
console  POST /api/platform/orgs/:id/mobile/builds   { artifactType }
   │
   ├─ readiness is evaluated                    core/platform/appBuilds.ts
   │    org active · native identity valid · five images present · EXPO_TOKEN set
   │    not ready → 422 with sentences, and NOTHING is queued
   │
   ├─ BuildJob written                          models/AppBuildJob.ts
   │    partial unique index refuses a second LIVE build of the same shape
   │
   └─ queued                                    queues/appBuildQueue.ts

worker  prepare                                 workers/appBuildWorkerCore.ts
   ├─ workspace assembled                       core/platform/appBuildWorkspace.ts
   │    a copy of CLIENT_APP_PATH containing ONE organization
   ├─ config/organizations/<slug>.js generated  core/platform/mobileBuild.ts
   ├─ config/registry.js generated              this org + the generic build only
   ├─ eas.json generated                        android.buildType apk | app-bundle
   ├─ five images downloaded                    core/platform/mobileAssets.ts
   ├─ identity verified and logged              verifyWorkspaceIdentity()
   └─ eas build --non-interactive --no-wait --json     core/platform/easClient.ts

worker  poll  (every 30–60s, its own short job)
   └─ FINISHED → artifact URL saved → console shows Download
```

Nothing waits. An HTTP handler returns in milliseconds and a forty-minute
Android build never occupies a worker slot.

## Initial setup

Two environment variables on whichever host runs the worker. Both are read
only by the server; neither ever reaches a browser.

| Variable | What it is |
|---|---|
| `EXPO_TOKEN` | A robot access token from expo.dev → Account settings → Access tokens. The only credential the build needs. |
| `CLIENT_APP_PATH` | Absolute path to the `client-platform-app` checkout on the build host, with `npm install` already run once. |

Optional:

| Variable | Default | What it changes |
|---|---|---|
| `EAS_CLI_COMMAND` | `npx --yes eas-cli@latest` | How the CLI is invoked. Pin a version on a build host so a CLI release cannot change what a build does. |
| `APP_BUILD_QUEUE_NAME` | `app-builds` | Set a distinct value locally — local and deployed servers share one Redis. |
| `APP_BUILD_CONCURRENCY` | `2` | Simultaneous prepares. |
| `APP_BUILD_MAX_POLLS` | `90` | When to stop asking EAS and record a timeout. |

The worker runs embedded in `npm start`, under the same one-instance gating as
the AI pipeline worker. `PPT_WORKER_EMBEDDED=false` turns both off.

Per organization, an administrator needs only: an active organization with its
native identity filled in (Mobile app tab) and the five images uploaded (App
builds → Native assets). No developer step at all.

## APK and AAB

They are different EAS configurations, not one binary renamed.

| | `android.buildType` | Produces | Use |
|---|---|---|---|
| APK | `apk` | `*.apk` | Sideload onto a test device |
| AAB | `app-bundle` | `*.aab` | Google Play. Will not install on a device |

Nothing is submitted to any store. The AAB is built and stored; publishing is a
separate, deliberate act that this system does not perform.

## Organization isolation

A build of Organization A cannot compile in Organization B's identity, because
nothing describing B is in the directory being uploaded: the workspace is
assembled from an allow-list, its registry names one institute plus the generic
build, and its `assets/` holds one institute's images.

`verifyWorkspaceIdentity()` then proves it before a build minute is spent —
reading the generated file back off disk, not trusting the value just written —
and the resolved identity is logged and stored on the BuildJob.

## Credentials

`EXPO_TOKEN` is read in exactly one module, `core/platform/easClient.ts`, and
passed to the child process. It is never logged, never returned, and
`redactSecrets()` scrubs it from anything stored. `publicBuildView()` is the
only shape the API returns, and it omits `errorDetail` — where a failed build's
CLI output lives.

The browser never talks to EAS. It polls this server.

## The existing manual workflow still works

Nothing was removed. `POST /orgs/:id/mobile/build-config` still returns the
file, the registry lines, the eas.json profile and the commands, and a
developer can still build by hand from `client-platform-app`. The automated
path is additive, and it builds in a throwaway workspace — it never writes into
anybody's checkout.

## Testing

| | What it proves | Cost |
|---|---|---|
| `npm run safety:app-build -- --scratch-suffix <s>` | The pipeline: permissions, readiness, idempotency, generated config, isolation, state machine, audit, secret containment. The EAS CLI is scripted. | Seconds |
| `npm run smoke:eas-build -- --org <id> --artifact apk` | The CLI integration, against the real Expo account, for one organization. Nothing stubbed. | Real build minutes |

Both exist because neither is sufficient alone. The first cannot prove the CLI
works; the second is too expensive to run in a suite. A stubbed build reported
as an end-to-end pass would be a lie about what has been verified.
