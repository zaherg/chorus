# Monospace Wireframe

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                           @zaherg/chorus  ──  System Wireframe               ║
╚══════════════════════════════════════════════════════════════════════════════╝

┌─────────────────────────────────────────────────────────────────────────────┐
│                              AGENT / USER INTERFACE                          │
│                                                                              │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │  $ consensus list-models --json                                     │    │
│   │  $ consensus --models "openai/gpt-5.2,anthropic/claude-sonnet-4-5"  │    │
│   │  $ echo '{...}' | consensus --stdin-json                            │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│   stdin ──► JSON request                          stdout ◄── JSON result    │
│   args  ──► --models, --prompt, --stance, ...      stderr ◄── errors/logs   │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLI ENTRY (src/cli.ts)                             │
│                                                                              │
│   ┌──────────┐    ┌─────────────┐    ┌────────────────┐                     │
│   │  --help  │───►│  printHelp  │    │  exit code: 0  │                     │
│   └──────────┘    └─────────────┘    └────────────────┘                     │
│                                                                              │
│   ┌─────────────┐   ┌──────────────────────┐                                │
│   │  --version  │──►│  consensus 0.0.1\n   │                                │
│   └─────────────┘   └──────────────────────┘                                │
│                                                                              │
│   ┌──────────────────┐   ┌───────────────────────────────────────────┐      │
│   │  consensus       │──►│  commands/consensus.runConsensusCommand   │      │
│   │  list-models     │──►│  commands/list-models.runListModelsCmd    │      │
│   │  (bare flags)    │──►│  commands/consensus.runConsensusCommand   │      │
│   └──────────────────┘   └───────────────────────────────────────────┘      │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│    CONSENSUS COMMAND          │  │    LIST-MODELS COMMAND        │
│    (commands/consensus.ts)    │  │    (commands/list-models.ts)  │
│                               │  │                               │
│  ┌─────────────────────────┐  │  │  ┌─────────────────────────┐  │
│  │ 1. loadConfig()         │  │  │  │ 1. loadConfig()         │  │
│  │ 2. configureLogging()   │  │  │  │ 2. configureLogging()   │  │
│  │ 3. model-catalog        │  │  │  │ 3. model-catalog        │  │
│  │    .loadCatalog()       │  │  │  │    .loadCatalog()       │  │
│  │ 4. createRegistry()     │  │  │  │    (models.list/1)      │  │
│  │ 5. resolve-route        │  │  │  │ 4. filter to configured │  │
│  │    .resolveRoute()      │  │  │  │    providers            │  │
│  │    (route_id → row)     │  │  │  │ 5. print human/JSON     │  │
│  │ 6. runConsensus()       │  │  │  └─────────────────────────┘  │
│  └───────────┬─────────────┘  │  │                               │
└──────────────┼────────────────┘  └───────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CONSENSUS ENGINE (src/consensus.ts)                     │
│                                                                              │
│   ┌───────────────────────────────────────────────────────────────────┐     │
│   │                         runConsensus()                             │     │
│   │                                                                    │     │
│   │  ┌──────────┐    ┌──────────────────┐    ┌──────────────────┐     │     │
│   │  │  embed   │    │  fan-out query   │    │   optional       │     │     │
│   │  │  files   │───►│  to N models     │───►│   synthesis      │     │     │
│   │  └──────────┘    └────────┬─────────┘    │  (opt-in only)   │     │     │
│   │                           │              └────────┬─────────┘     │     │
│   │                    ┌──────┴──────┐                │               │     │
│   │                    │  PARALLEL   │         ┌──────┴──────┐        │     │
│   │                    │  ┌────────┐ │         │  generate   │        │     │
│   │                    │  │ Model A│ │         │  synthesis  │        │     │
│   │                    │  │ Model B│ │         │  text()     │        │     │
│   │                    │  │ Model C│ │         └─────────────┘        │     │
│   │                    │  └────────┘ │                                 │     │
│   │                    │  bounded    │                                 │     │
│   │                    │  concurrency│                                 │     │
│   │                    └─────────────┘                                 │     │
│   │                                                                    │     │
│   │                    ┌─────────────┐                                 │     │
│   │                    │ SEQUENTIAL  │                                 │     │
│   │                    │ A ─► B ─► C │  (each sees prior responses)    │     │
│   │                    └─────────────┘                                 │     │
│   │                                                                    │     │
│   │   Failed participants keep their route_id and carry                │     │
│   │   response: null + structured error. Broker never auto-picks.     │     │
│   └───────────────────────────────────────────────────────────────────┘     │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  BROKER LAYER (src/providers/)                               │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────┐          │
│   │  model-catalog.ts        provider-map.ts    resolve-route.ts │          │
│   │  fetch + cache           internal id ↔      route_id parser  │          │
│   │  models.dev catalog      models.dev key     exact / unqual.  │          │
│   │  models.list/1                              / passthrough    │          │
│   └──────────────┬───────────────────────────────────────────────┘          │
│                  │                                                           │
│                  ▼                                                           │
│   ┌──────────────────────────────────────────────────────────────┐          │
│   │                     ProviderRegistry                          │          │
│   │                                                               │          │
│   │  ┌──────────────────┐   ┌──────────────────────────────────┐ │          │
│   │  │ isProviderConfigured│ │  generateText(route_id, prompt) │ │          │
│   │  └──────────────────┘   │   - resolve via catalog row     │ │          │
│   │                          │   - get factory                  │ │          │
│   │                          │   - build options                │ │          │
│   │                          │   - call AI SDK generateText()   │ │          │
│   │                          └────────────┬─────────────────────┘ │          │
│   └─────────────────────────────────────────┼─────────────────────┘          │
│                                             │                                │
│   ┌──────────────────┐                      │                                │
│   │ custom-url.ts    │                      │                                │
│   │ validateCustomUrl│                      │                                │
│   │ SSRF guard       │                      │                                │
│   └──────────────────┘                      │                                │
└─────────────────────────────────────────────┼────────────────────────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL (Vercel AI SDK v7)                         │
│                                                                              │
│   ┌────────┐  ┌───────────┐  ┌────────┐  ┌───────────┐  ┌────────┐        │
│   │ OpenAI │  │ Anthropic │  │ Google │  │ OpenRouter│  │ Custom │  ...   │
│   │  API   │  │   API     │  │  API   │  │   API     │  │  API   │        │
│   └────────┘  └───────────┘  └────────┘  └───────────┘  └────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║                      MODELS-DEV CATALOG CACHE                                ║
╚══════════════════════════════════════════════════════════════════════════════╝

   https://models.dev/catalog.json
              │  fetch on miss or --refresh
              ▼
   ┌────────────────────────────────────────────────────────┐
   │  ~/.config/chorus/models-cache/                 │
   │                                                        │
   │  catalog.json     full catalog payload (validated)     │
   │  metadata.json    fetched_at, expires_at, source        │
   │                                                        │
   │  TTL: 24h default                                      │
   │  Stale fallback: previous cache used on refresh fail   │
   └────────────────────────────────────────────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║                        CONFIG & INFRASTRUCTURE                                ║
╚══════════════════════════════════════════════════════════════════════════════╝

┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│      ~/.config/chorus/    │   │           Logging                │
│                                  │   │                                  │
│  ┌────────────────────────────┐  │   │  ┌──────────────────────────┐   │
│  │       config.json          │  │   │  │  ~/.config/.../logs/     │   │
│  │                            │  │   │  │                          │   │
│  │  cli_timeout_ms: 30000    │  │   │  │  error.log  (warn+)      │   │
│  │  provider_timeout_ms:     │  │   │  │  stderr      (all)       │   │
│  │    120000                 │  │   │  │                          │   │
│  │  log_level: "info"        │  │   │  │  JSON Lines format       │   │
│  │  max_concurrent: 5        │  │   │  │  Rotating (5MB x 3)      │   │
│  │                            │  │   │  │  Secret redaction       │   │
│  │  openai_api_key:          │  │   │  └──────────────────────────┘   │
│  │    "$OPENAI_API_KEY"      │  │   │                                  │
│  │  anthropic_api_key: ...   │  │   └──────────────────────────────────┘
│  │  custom_url: ...          │  │
│  │                            │  │   ┌──────────────────────────────────┐
│  │  Zod v4 validated          │  │   │           Utilities              │
│  │  0700 dir / 0600 file      │  │   │                                  │
│  │  $ENV_VAR resolution       │  │   │  errors.ts  getErrorMessage()   │
│  └────────────────────────────┘  │   │  files.ts   embedFiles()        │
│                                  │   │  tokens.ts  estimateTokenCount() │
└──────────────────────────────────┘   └──────────────────────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║                          CONSENSUS DATA FLOW                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝

     ┌──────────────┐
     │  1. Prompt   │  "Should we use a monorepo?"
     └──────┬───────┘
            │
     ┌──────┴──────────────────────────────────────────────┐
     │  2. Fan-out to models (parallel or sequential)       │
     │                                                      │
     │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
     │  │   Model A   │  │   Model B   │  │   Model C   │  │
     │  │ route_id:   │  │ route_id:   │  │ route_id:   │  │
     │  │ openai/gpt-5│  │ anthropic/  │  │ google/     │  │
     │  │  stance:for │  │ sonnet-4-5  │  │ gemini-2.5  │  │
     │  │            │  │ st:against  │  │ st:neutral  │  │
     │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
     └─────────┼────────────────┼────────────────┼──────────┘
               │                │                │
               ▼                ▼                ▼
     ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
     │  Response A │  │  Response B │  │  Response C │
     │  "monorepo  │  │  "polyrepo  │  │  "depends   │
     │   is better"│  │   scales"   │  │   on team"  │
     └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
            │                │                │
            └────────┬───────┴───────┬────────┘
                     │               │
                     ▼               ▼
            ┌────────────────────────────┐
            │  3. Broker collects         │  at least 1 success required
            │     raw responses           │  failures stay in models[] with
            │     (no ranking)            │  response: null + structured error
            └─────────────┬──────────────┘
                          │
                          ▼
            ┌────────────────────────────┐
            │  4. Optional synthesis      │  ONLY when --synthesis-model is
            │     (--synthesis-model)     │  set AND at least one participant
            │                              │  response succeeded.
            └─────────────┬──────────────┘
                          │
                          ▼
            ┌────────────────────────────┐
            │  5. Build synthesis prompt  │
            │     proposal + responses    │
            └─────────────┬──────────────┘
                          │
                          ▼
            ┌────────────────────────────┐
            │  6. Query synthesis model   │
            │     (opt-in, never auto)    │
            └─────────────┬──────────────┘
                          │
                          ▼
            ┌────────────────────────────────────────┐
            │  7. JSON to stdout                       │
            │     schema: cli.consensus/2             │
            │     models[] + optional synthesis      │
            └────────────────────────────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║                           EXIT CODE ROUTING                                   ║
╚══════════════════════════════════════════════════════════════════════════════╝

                    ┌─────────────┐
                    │  runCli()   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┬────────────────┐
              ▼            ▼            ▼                ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐     ┌──────────┐
        │  exit 0  │ │  exit 1  │ │  exit 2  │     │  exit 3  │
        │ Success  │ │  Broker  │ │  Arg     │     │  Model   │
        │ (≥1 part.│ │  Error   │ │  Parse   │     │  Resolve │
        │  success)│ │          │ │  Error   │     │  Error   │
        └──────────┘ └──────────┘ └──────────┘     └──────────┘
```

The CLI reads its version from `package.json` at build time. The skill-local installer (`scripts/install.sh`) downloads the matching GitHub Release binary into `bin/consensus`.
