# Cloudflare Media frame probe

This benchmark calls the Worker-to-Media extraction path directly. The test Worker
has the real Media binding and a separate admission Durable Object. It has no
container binding, image, agent, or frame catalog. The four allowlisted POST
routes require a benchmark bearer token. They return JPEG dimensions and safe
extraction events, not media bytes or signed URLs.

Deploy the benchmark's wrangler.jsonc under a fresh test Worker name. Set
BENCHMARK_TOKEN to a new random secret and OUTBOUND_PROXY_URLS to a JSON array
containing the single test exit. Configure secrets only on the temporary Worker.
Never upload the whole agent-test env file.

Set FRAME_BENCHMARK_URL and FRAME_BENCHMARK_TOKEN, then run
`node platform/benchmarks/frame-playback/run.mjs`. Requests are serial. The first
video requests frames at 14:05, 14:08, 14:12 and 14:16, then seeks to 14:21. The
second requests 5:00, then seeks to 5:05. The runner reports extraction time and
measured image dimensions and exits unsuccessfully if any requested HD frame is
missing. New timestamps avoid frame-cache hits. The current Media source resolver
starts fresh per request, so these are follow-up seek timings, not attested
session-cache hits. Remove the test Worker and its token afterward.

## November 6, 2026 measurements

The customer-facing Worker (version `a0f69c75-293e-40dc-b812-b574406a76c9`)
used Cloudflare Media. Both [the 14:05.750 run](https://www.video2ctx.dev/dashboard/sessions/5c7e7d87-af43-457b-87a3-c74695bf7467)
and [the 5:00.750 run](https://www.video2ctx.dev/dashboard/sessions/e378ca59-d7be-451c-9416-dda7fa79fbc9)
recorded HTTP 206 for the HD index, HTTP 403 on the later HD read, and a successful
Media decode using the 640×360 progressive source. Extraction took 7.741 s and
7.357 s respectively. The production proxy secret was not inspected.

The separate hosted Media-only Worker (version `19a9fd28-5c83-4780-aa87-d6c1d937f243`)
used one fixed Oxylabs test exit. All four requests returned JPEGs, but none met the
HD requirement. Values are full extraction times inside the test Worker.

| Video | First request | Next seek | Returned size |
| --- | ---: | ---: | --- |
| ZmLg3_Bv2vY | 7.511 s (4 frames) | 5.185 s (14:21) | 640×360 |
| aqz-KE-bpKQ | 4.959 s (5:00) | 4.069 s (5:05) | 640×360 |

Three of these four requests recorded an HD 403. The 5:05 seek recorded an HD
index read and a successful 360p decode, but its compact HTTP trace did not record
an HD 403. All four passed the container-free path check and failed the HD check.
An earlier hybrid deployment had container transport errors; no hybrid or
deployment-transition samples are included in this table.

A separate decoder-only probe supplied already-fetched, attested H.264 segments
from the two follow-up positions. Through a real remote Media binding, both
returned HTTP 200 JPEGs measuring 1920×1080. Binding round trips were 3.108 s
(547,692 input bytes) and 2.441 s (942,545 input bytes). These numbers include
transport through the developer-machine bridge and exclude obtaining HD media.
The clips were prepared using the existing container-based fetcher. This
demonstrates HD decoding, not container-free end-to-end HD or a session-reuse
speedup.

## Worker-issued playback proofs, November 6

A subsequent experiment deployed a temporary Worker with a network-isolated
Worker Loader and the Media binding. It used one dedicated Oxylabs test exit
from the agent-test configuration. The Worker fetched mobile player metadata,
resolved the stream URL challenge and obtained the matching YouTube homepage
challenge. The isolated runtime initialized the interpreter during startup,
then minted visitor-bound and video-bound proofs. All four requests confirmed
that the observed exit matched the IP in the signed stream URL.

| Video and request | Proofs ready | Elapsed until rejection |
| --- | ---: | ---: |
| ZmLg3_Bv2vY, four frames starting at 14:05 | 6.01 s | 15.49 s |
| ZmLg3_Bv2vY, 14:21 | 5.61 s | 14.66 s |
| aqz-KE-bpKQ, 5:00 | 5.82 s | 6.58 s |
| aqz-KE-bpKQ, 5:05 | 6.49 s | 7.69 s |

The final test version was `dd979619-2686-4d8f-af92-f3f99740616e`.
All media HTTP responses had status 200. Each token variant received stream
protection status 3 (rejected) on each request. None produced an HD frame,
invoked the Media decoder, or seeded a playback session. Both later seeks
therefore performed fresh lookups. The rejection identifies the failing stage.
YouTube supplied no reason distinguishing the token, player session, or their
combination.

## Controlled token swap, November 6, 05:58 UTC

The temporary authenticated Worker `video2ctx-token-swap-nov06` (code revision
`swap-1`, initial deployment `edc28853-ad7b-41bd-9d91-4ea5a8ced02f`) and the local
Docker image `video2ctx-frames:pinned-local` used the same dedicated Oxylabs
port 8001 from the agent-test configuration. The image ID was
`sha256:f15e9ef8719b41e9a913ff4aa25743d52b91c2d31bcae9c66d548b4cc38839d1`.
This compares a hosted Worker with a local container through one proxy, not
direct Cloudflare Worker versus hosted Cloudflare Container egress.

For `ZmLg3_Bv2vY` at 14:05, all rows reused one mobile-web player response,
resolved stream URL, client headers, format selection, and content binding.
The Worker minter received the same homepage configuration, challenge program,
and interpreter source captured from the container minter. This session requested
a video-bound token. Container setup and every Worker operation checked the
proxy's observed exit against the IP in the signed stream URL. Worker integrity
issuance and media reads both used the configured proxy tunnel.

| Token generator | Media requester | Result | Stream read time |
| --- | --- | --- | ---: |
| Container | Container | Accepted, HD video data | 7.909 s |
| Container | Hosted Worker | Accepted, HD video data | 5.275 s |
| Hosted Worker | Container | Rejected, protection status 3 | 6.650 s |
| Hosted Worker | Hosted Worker | Rejected, protection status 3 | 4.749 s |
| Container, original token recheck | Container | Accepted, HD video data | 7.921 s |

Accepted reads selected H.264 itag 299, 1920×1080, and returned an initialization
chunk plus video media, totaling 668,401 bytes. These swap tests stopped after
the media fragment and did not invoke a decoder. All media HTTP responses were
200, including rejected responses containing only protocol messages. Timings
exclude session setup, Worker exit verification, token generation and decoding;
they are sequential diagnostic samples, not a latency benchmark.

The unchanged container endpoint separately decoded 1920×1080 JPEGs for both
`aqz-KE-bpKQ` and `ZmLg3_Bv2vY` in 13.451 s and 13.348 s. Fresh sessions in the
diagnostic harness were intermittent: the second video's two matrix attempts
failed the initial container-token check, so no Worker swaps were attempted
on those sessions. An earlier diagnostic session for that video did receive
HD data with its primary container token. An absent alternate token was also
tested during harness setup; that refusal is not evidence about a generated
token and is excluded from the comparison above.

This successful-session comparison isolates the rejection to the proof-generation
path, rather than the media requester's runtime or proxy exit. It does not reveal
YouTube's private validation reason. Remaining differences include Node versus
Worker runtime, JSDOM 29.1.1 versus 26.1.0, snapshot execution during normal Node
execution versus Worker startup, and Axios versus Worker-tunnel transport for
integrity issuance. Both used bgutils-js 4.0.3. Further tests must separate those
differences before attributing the rejection to a particular browser signal or
TLS fingerprint. The temporary Worker and local diagnostic containers were
removed after testing; production was unchanged.

## Separating proof runtime from integrity issuance

A subsequent controlled test used the same fixed proxy and one fresh playback
session for `ZmLg3_Bv2vY` at 14:05 throughout. The temporary Worker ran code
revision `issuance-1`, initial deployment
`8ae21bbc-694e-43b4-a4ce-dfbdd6ef5004`. All playback checks ran in the container.
The experiment changed the runtime generating the proof and the runtime sending
the integrity issuance request independently.

| Snapshot and local minter runtime | Integrity request sender | Playback result |
| --- | --- | --- |
| Container | Container | HD accepted |
| Container | Hosted Worker | HD accepted |
| Hosted Worker | Hosted Worker | Rejected, protection status 3 |
| Hosted Worker | Container | Rejected, protection status 3 |
| Container, fresh control repeated | Container | HD accepted |

The original container token also worked before and after this matrix. Accepted
cases returned initialization and video chunks for 1920×1080 H.264 itag 299,
totaling 668,401 media bytes. Rejected cases returned no video chunks. These
were media acceptance tests, not new frame-decoder or latency benchmarks.

Controls held constant the playback URL and configuration, target time, mobile
client headers, selected format, content binding, homepage configuration,
challenge program and interpreter source. The issuance endpoint, method,
explicit headers and body structure were shared. Only the snapshot field varied
with a fresh proof generation. Every issuance and playback check verified the
proxy exit against the signed stream URL. Worker minters retained their own
snapshot state across the exchange round trip; a snapshot hash check rejected
any unexpected runtime restart. All four cases passed that check.

An important harness correction preceded the valid matrix. Recreating a minter
from the same callback state was not a valid control: even with the original
integrity response, its output grew from 124 to 216 characters and was rejected.
Recreating it again produced 304 characters. The original 124-character token
was verified to match the provider's returned token and was accepted.
Therefore those remint/reissue failures are excluded from transport conclusions.
The corrected experiment generated fresh callback state and initialized each
minter exactly once. It did not reuse byte-identical snapshots across issuers;
fresh proof randomness and elapsed time remain uncontrolled differences between
individual cases. The repeated container controls reduce that ambiguity.

The valid cases returned 88-character integrity responses and 124-character
playback tokens for container-generated proofs, versus 96 and 128 characters
for Worker-generated proofs, regardless of issuer. These lengths are observations,
not a decoded rejection reason. Both issuers received a nominal 43,200-second
integrity lifetime, so successful issuance alone did not establish valid playback.

This matrix shows that the Worker's issuance transport can produce an accepted
playback token, and that using the container's issuance transport does not rescue
the Worker-generated proof. It narrows the cause to runtime-side proof generation
(snapshot signals and/or local minting), rather than the identity of the issuance
sender. It does not isolate a particular browser property. Remaining runtime
differences include JSDOM version, Worker startup execution and the host APIs
visible to the interpreter. This was one completed matrix on one video and one
exit, not a reliability-rate estimate or a claim about every Cloudflare region.
The temporary Worker, benchmark secret and local test container were removed.
Production was unchanged.

## DOM, browser properties, and the final mint execution phase

The next experiment retained one playback session for `ZmLg3_Bv2vY` at 14:05
and the same verified Oxylabs exit throughout. The container continued to fetch
all media. Its original token passed repeated checks before and after the
experiments. The diagnostic Worker progressed through revisions `dom-1` to
`dom-6`; the final deployment was
`6787e45c-2f88-49d6-a5b8-1ef8cdd21de7`.

### Matching measured browser properties

JSDOM 26.1.0 was first replaced with the container's JSDOM 29.1.1. Initial
startup failures were packaging failures, not YouTube rejections. The bundle
needed distinct internal import names, static imports for CSS JSON data, the
unchanged default stylesheet embedded instead of loaded from disk, and a static
path for the unused synchronous-XHR worker. Synchronous XHR in a native Node
worker thread was not implemented or exercised. These adaptations do not make
the entire Worker DOM equivalent to the container's native environment.

Once JSDOM 29 ran, the following settings were matched cumulatively, changing
one setting per test. Every valid playback test in this chain was rejected.

| Setting | Original Worker | Container / matched value |
| --- | --- | --- |
| JSDOM version | 26.1.0 | 29.1.1 |
| DOM navigator user agent | JSDOM's default user agent | Container's configured browser-style user agent |
| DOM navigator CPU count | 0 | 8 |
| Global navigator user agent | `Cloudflare-Workers` | `Node.js/26` |
| Global navigator platform | Empty string | `Linux arm64` |
| Global navigator language | `en` | `en-US` |
| Global navigator languages | `["en"]` | `["en-US"]` |
| Global navigator CPU count | 1 | 8 |

Separate tests removing the global `getComputedStyle` or `dispatchEvent`
function also produced rejected tokens. Making `window` and then `document`
enumerable, then changing the global `navigator` property to a getter, did not
restore acceptance. These tests matched measured values and selected descriptors;
they did not reproduce every native prototype, function implementation, or
browser capability.

Removing the global `addEventListener` function stopped the proof minter from
initializing. Removing its paired `removeEventListener` function as the next
change did not recover it: the snapshot had no minter callback. Deferring
snapshot generation from Worker startup to request handling also produced no
minter callback. These are local runtime failures, not evidence of a YouTube
playback refusal. One fresh container proof failed during the broader experiment;
the original token and a repeated fresh container proof passed. Original-token
checks continued passing through the final experiments.

### A reproducible final-mint phase difference

To separate Google's integrity response from local minting, a fresh container
minter was first given the original, accepted container integrity response. It
produced an accepted token, validating reuse of that response with fresh minter
state for this captured challenge. A Worker minter given exactly the same
response produced a rejected token during request handling.

The Worker was then tested with its snapshot generated at startup in all cases,
the same JSDOM 29 and matched navigator configuration, and the same accepted
integrity response and video binding. Only the execution phase changed:

| Minter initialization | Final video-token mint call | Result |
| --- | --- | --- |
| Request handling | Request handling | Rejected, 120-character token |
| Startup | Startup | HD accepted, 124-character token |
| Request handling, reversal | Request handling | Rejected, 120-character token |
| Startup, repeated | Startup | HD accepted, 124-character token |
| Startup | Request handling | Rejected, 120-character token |

Accepted cases returned 668,401 bytes of initialization and video media for
1920×1080 H.264 itag 299. Rejected cases returned no media and protection status
3, despite HTTP 200. Initializing the factory at startup was insufficient: the
final `WebPoMinter.mintAsWebsafeString()` call also had to run at startup in this
experiment. Each case used fresh callback state and initialized its minter once.
The successful/failed/successful reversal confirms a phase-sensitive local
minting incompatibility, not merely an IP or player-session change.

This identifies the affected operation, not the interpreter's exact internal
instruction. Cloudflare documents [different dynamic-code execution rules at
startup](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-eval-during-startup)
and [different timer semantics](https://developers.cloudflare.com/workers/runtime-apis/performance/).
Neither mechanism was directly traced inside the interpreter, so neither is
claimed as the proven low-level cause.

### Startup minting is not a complete Worker-only fix

A Worker-generated snapshot was separately exchanged through the same Worker
proxy route. Its integrity response was then supplied to fresh Worker minters
using the same captured challenge and binding. Request-time minting produced a
rejected 128-character token; startup minting produced a rejected 132-character
token. The original container token still worked afterward. Thus, fixing the
final-mint phase did not make the Worker's own snapshot/issuance path usable.
Cross-instance reuse of that Worker-origin integrity response was not separately
validated, so this result does not identify its exact rejection reason.

Native Canvas was another observed capability difference: the container had a
working `canvas` package, while the Worker bundle had none. Fresh container
processes were tested with that optional module enabled, disabled, enabled,
and disabled, using the same captured challenge, binding, issuer, playback
session and exit. All four produced accepted 124-character playback tokens.
Missing Canvas therefore did not reproduce the Worker failure in this control.

The confirmed finding is a local final-mint execution-phase incompatibility.
Matching the tested DOM/browser properties was insufficient. The remaining
Worker-origin snapshot/integrity failure is unresolved, and no fully
Worker-only HD implementation or production rollout is claimed.
The temporary Worker, benchmark secret and local comparison container were
removed after testing. Production was unchanged.

## End-to-end hosted hybrid path

The [hybrid benchmark](./hybrid/README.md) joined container-generated playback
sessions, Worker HD fetching through the same dedicated proxy, and Cloudflare
Media decoding. Both videos returned 1920×1080 frames. Across three matched
rounds, first requests took 17.093–17.532 seconds for four frames on
`ZmLg3_Bv2vY` and 13.040–15.137 seconds for one frame on `aqz-KE-bpKQ`.
Cached one-frame seeks took 5.795–5.848 seconds for the first video. The second
had two approximately 2.1-second seeks and one 16.150-second fetch outlier.

The final matched round spent about 10.45 seconds creating each session. Reuse
removed that entire stage and the repeated exit check. Media decoding took
0.600–1.379 seconds. The first video also showed an exact four-second gap
between its two upstream requests, consistent with the client's server-directed
backoff handling; the policy value itself was not captured.

Those numbers describe ready services, not cold deployment behavior. Seven of
20 extraction attempts failed during provider startup or container rollout;
the detailed report preserves every failure and an additional uncached recovery.
No production reliability claim follows from the successful matched rounds.
The last local startup-wait correction passed a CPU-limited test but was not
redeployed. See the linked report and sanitized `results.json` for the complete
timings, validation, deployment versions and limitations.
