# Technical notes — 1.3.2

The binary path is unchanged from 1.3.1. Explicit local typed-array allocation/copy
avoids foreign-realm `constructor[Symbol.species]` lookups. ZIP integrity is CRC32
plus an independent SHA-256/size manifest for all other entries.

Capture now performs a bounded overlapping viewport sweep of mounted messages
before visiting persistent shells. Neighbor snapshots and evicted snapshots are
merged by stable identity and existing snapshot score. The sweep does not expand
panels; the existing shell phase opens recognized disclosures and restores them.

An observed integer order gap is reported rather than silently accepting a matched
shell count as a complete census. `expectedTotal` remains null. `completeConversationVerified`
and `certifiedComplete` remain false. A prefix/suffix, alternate branch, virtualized
code editor, inner scroll area or inaccessible panel can still be absent.

HTML links are ambiguous and are no longer classified solely from `.html/.htm`.
Explicit download controls, sandbox references and trusted attachment UI remain
supported. This does not add permissions or fetch external documentation sites.

Visual evidence keeps original discovery metadata as well as final ordinal labels.
A last unphotographed scroll advance cannot count as captured bottom coverage.

Regression scope is recorded in tests/RESULTADOS.json. Node and mocked Chromium
results must not be represented as a Firefox integration or authenticated service test.
