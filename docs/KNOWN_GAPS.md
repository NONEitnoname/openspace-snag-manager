# Known gaps — 2026-07-17

Honest list of what is not finished or not proven. Read this before claiming the pilot is complete.

## 1. A MimaarAI analysis has never completed end-to-end

**Status: blocked on account quota, not on code.**

The pilot's service account `snag-pilot@mimarai.com` is registered and wired
(`MIMARAI_EMAIL` / `MIMARAI_PASSWORD` on Railway). Proven live:

- `POST /api/v1/analyze` accepts the job (`202` + `jobId`) and the analysis genuinely runs — a direct probe reached `progress: 36`, "detecting defects".
- The app authenticates correctly: a live run returns the provider's `429 Daily usage limit reached`, **not** a `401`.

Not proven: draft findings arriving from a real image, and therefore the
review → approve → promote chain on *real* AI output (it is proven on seeded data).

**Why:** the account is `usageTier: free` — `maxRequestsPerDay: 10`,
`maxRequestsPerMonth: 100`. **Every status poll is charged against that quota**, so a
single analysis (1 submit + N polls) cannot finish inside 10 requests/day.

**To unblock:** raise the tier for `snag-pilot@mimarai.com` (user id
`3d58c376-5e2e-4d75-b778-dd1b06c7a6f1`) in the MimaarAI admin, then re-run one
analysis from the Capture & analyze tab.

**Recommended fix on the MimaarAI side:** don't charge `GET /api/v1/analyze/:jobId`
against the analysis quota. Polling a long-running job is not a new unit of work, and
charging it means any well-behaved client throttles itself out mid-job.

## 2. The provider loses jobs between replicas

`GET /api/v1/analyze/:jobId` answers `200 / 404 / 404 / 200` for a job that is
running, because jobs live in an in-memory `Map` and mimarai.com serves several
replicas. This client tolerates it (see the polling loop and `__tests__/provider.test.js`),
but the provider should move job state to shared storage — otherwise every client must
carry the same workaround, and a job whose replica dies is lost silently.

## 3. Nothing in the repo tests the capture path

`captureViewer()` and `cropToViewer()` have **no automated coverage at all**. The test
suite is server-side supertest only (no jsdom, no browser runner), so nothing committed
here exercises them — do not read the suite passing as evidence they work.

They were checked by hand in a browser during development, by stubbing `getDisplayMedia`
with a canvas stream: the crop landed on the viewer rect (869×554) with no surrounding
page chrome. That was a live session, not a test, and it is gone. Chromium's "choose what
to share" dialog cannot be driven from automation either, so the picker → real tab frame
leg has only ever been reasoned about.

Worth a manual pass on a real capture, and worth a browser-based test runner if this
becomes more than a pilot.

## 3b. The app cannot tell whether OpenSpace actually served a capture

The viewer status says "Linked to capture", which means only that the link in the box is
what we last pointed the frame at. The frame is cross-origin: if OpenSpace redirects to
its login page, the share link has expired, or the capture is empty, the app cannot see
it and the status will not change. `contextMatchesViewer()` is bookkeeping, not proof.

Related: navigation *inside* the frame is only detected when it is a full document load.
If OpenSpace's player moves between captures with client-side routing, no `load` event
fires, the link is not marked stale, and a capture could be attributed to the previous
location. The "OpenSpace home" button and full navigations are covered; SPA routing is not.

## 4. Signing in to OpenSpace inside the frame is unverified with a real account

The viewer defaults to `https://<region>.openspace.ai/`, which OpenSpace redirects to its
login page when signed out. Verified: the page returns 200 with no `X-Frame-Options` and
no `frame-ancestors`, its `SESSION` cookie is `SameSite=None; Secure` (i.e. intended for
cross-site embedding), and the login screen renders inside the app's iframe.

Not verified — nobody here has an OpenSpace account:

- whether a **login actually completes** in the frame and the resulting session loads a capture;
- **SSO** (Procore, Autodesk) almost certainly will not work framed, since identity providers
  typically send `X-Frame-Options: DENY`. The UI says so and offers a new-tab escape hatch;
- under **third-party storage partitioning** (Safari today, Chrome depending on settings), a
  session established in a *separate tab* may not be visible to the iframe. Signing in
  *inside* the viewer is the path most likely to work everywhere.

One pass with a real account is the thing to do before the pilot starts.

## 5. OpenSpace is embedded, never written to

Handoff records a Field Note URL that a human pastes after creating the note in
OpenSpace by hand. There is no OpenSpace API integration, and `payload_hash` records
what *would* have been sent. OpenSpace remains the system of record; this app never
claims to have created anything there.

## 6. Legacy resolution dates on the trend chart are inferred, not recorded

`resolved_at` was added after the fact. Snags already Resolved/Closed at that point had
only `updated_at` to go on, so migration v1 (`db/database.js`) filled them from it once.
Those rows are plotted on the "closed out" line at their last-edited date, which may be
later than the day they actually closed, and the chart does not distinguish them from
genuinely stamped rows. Bounded: one-time, only rows predating the column, and nothing
infers a resolution date ever again.

## 7. The audit log has no reader

`audit_events` records every decision — including, since this pass, what the AI produced
per asset and what it failed on. There is no route and no UI to read it back; the Admin
tab only issues invites. For a pilot whose product is the audit trail, that is a real
hole: today the only way to answer "why is this snag here" is `sqlite3` on the volume.

## 8. Bootstrap admin still enabled

`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` are still set on Railway.
They are a no-op while a user exists, but should be removed from the service
variables now that the admin account is created.
