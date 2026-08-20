# TODO

## Aggregate terminal semantics as host policy

The multi-branch runner currently aggregates branch outcomes into the run
status: one failed branch marks the whole run `failed` (exitCode 1) once every
branch finishes. That is CI-workflow semantics. For a long-lived research
universe (AutoDiscovery), a failed experiment branch is data, not a process
status: refuted hypotheses should be chart final states, and even genuine
experiment failures (tool crash, context exhaustion) must not mark the
universe run as failed.

Future change: make terminal aggregation a host policy. For research hosts,
the run status reflects "runner alive / stopped"; per-branch outcomes remain
per-branch facts. Default policy keeps today's aggregate behavior for
workflow-style hosts.

## Live rewind

`rewindHyperchartRun` requires a stopped run (`assertStoppedRun`). In a
perpetually live universe process, the human verdict "conclusion is wrong —
cut and rebuild" (a rewind of one branch) currently needs stop-the-world for
the whole runner. Acceptable for v1 (verdicts are rare); later consider a
controller-level rewind that quiesces only the affected branch.

## Inspector graph edge routing

The top-down ELK layout currently chooses edge sides from declaration order,
not from final node geometry. Vertically aligned nodes and backward edges can
therefore share left-side orthogonal corridors, making source and destination
hard to follow. The graph also lacks adjacency highlighting, so dense routes
remain ambiguous on hover or keyboard focus.

Future change, in order:

1. Highlight the selected or hovered node's incoming and outgoing edges and
   dim unrelated nodes and edges.
2. Choose source and target sides from final laid-out geometry.
3. Let ELK distribute multiple ports along a side instead of fixing every edge
   to one point.
4. Reserve separate lanes for backward edges.
5. Increase arrowhead contrast after routing is unambiguous.

Keep this as topology presentation work. Do not couple it to an execution
Timeline or change runtime semantics.

## Inspector run-definition provenance

A durable run currently stores the chart path, but run inspection reloads the
current source at that path. After the chart is edited, an old log can therefore
be presented against states and definitions that were never part of the
executed run even when the surviving log prefix remains replay-compatible.

Future change: persist the normalized executed chart snapshot and/or a stable
content hash in run metadata. Replay and historical inspection should use the
executed definition. The Inspector should separately expose the executed and
current definitions, compare their hashes, and label definition drift instead
of silently blending current source into historical run presentation.
