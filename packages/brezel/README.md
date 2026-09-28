# Brezel driver

This package connects Starsling's sandbox benchmark to a self-hosted
[Brezel](https://github.com/infercrane/brezel) endpoint through the public
`@infercrane/brezel` SDK.

Required configuration:

- `BREZEL_API_URL`: HTTPS URL of the qualified Brezel API.
- `BREZEL_API_KEY`: bearer token for the benchmark project.
- `BREZEL_PROJECT_ID`: a project used only by Starsling.
- `BREZEL_ENVIRONMENT_REVISION`: immutable, operator-prepared environment revision containing the
  benchmark toolchain and configured for the 4 vCPU / 8 GiB target.

The dedicated-project requirement is load-bearing. Brezel does not currently attach arbitrary
benchmark labels to sandboxes, so inventory treats every nonterminal sandbox visible to this token
and project as benchmark-owned. Never point the driver at a project containing user workloads.

The environment is deliberately recorded as `artifact: none`: Starsling neither builds nor
publishes the environment revision. Results are not comparable publication evidence until the
revision, Linux/KVM endpoint, request shape, cleanup, and full benchmark run are qualified and the
result bundle records those facts.
