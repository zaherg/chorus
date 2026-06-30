# Function Call Graph

ASCII flowchart showing which functions call which, organized by source file.

```
LEGEND:  ──►  direct call    ····►  indirect/lazy/dependency injection

═══════════════════════════════════════════════════════════════════════════════
ENTRY POINT
═══════════════════════════════════════════════════════════════════════════════

src/cli.ts
  runCli()
    ├── config.loadConfig()
    ├── printHelp()
    ├── commands/consensus.runConsensusCommand()
    └── commands/list-models.runListModelsCommand()


═══════════════════════════════════════════════════════════════════════════════
CLI COMMANDS
═══════════════════════════════════════════════════════════════════════════════

src/commands/consensus.ts
  runConsensusCommand()
    ├── config.loadConfig()
    ├── utils/logger.configureLogging()
    ├── providers/model-catalog.loadCatalog()
    │     ├── FileReader
    │     ├── FileWriter
    │     ├── fetchFn (globalThis.fetch)
    │     └── → writes ~/.config/chorus/models-cache/{catalog,metadata}.json
    ├── providers/registry.createProviderRegistry()
    ├── providers/resolve-route.resolveRoute()
    ├── parseModelKeyValueFlags()
    ├── parseRepeatableFlag()
    ├── parseSingleFlag()
    ├── parseBooleanFlag()
    │
    └── consensus.runConsensus()
          ├── utils/files.embedFiles()
          ├── runSettledWithConcurrency()  ──►  queryModel()
          └── registry.generateText()

src/commands/list-models.ts
  runListModelsCommand()
    ├── config.loadConfig()
    ├── utils/logger.configureLogging()
    ├── providers/model-catalog.loadCatalog()
    │     ├── FileReader
    │     ├── FileWriter
    │     ├── fetchFn (globalThis.fetch)
    │     └── → writes ~/.config/chorus/models-cache/{catalog,metadata}.json
    ├── providers/registry.isProviderConfigured()
    └── formatHuman() / JSON.stringify()


═══════════════════════════════════════════════════════════════════════════════
CORE CONSENSUS ENGINE
═══════════════════════════════════════════════════════════════════════════════

src/consensus.ts
  runConsensus()
    ├── utils/files.embedFiles()
    │     ├── isAllowedPath()
    │     ├── getAllowedRoots()
    │     └── utils/tokens.estimateTokenCount()
    │
    ├── runSettledWithConcurrency()          (parallel mode)
    │     └── queryModel()                   (spawned per model)
    │           ├── buildConsensusPrompt()
    │           └── registry.generateText()
    │
    ├── queryModel()                         (sequential mode, called directly)
    │     ├── buildConsensusPrompt()
    │     └── registry.generateText()
    │
    ├── buildSynthesisPrompt()
    │
    └── registry.generateText()              (optional synthesis call)


═══════════════════════════════════════════════════════════════════════════════
PROVIDER SYSTEM
═══════════════════════════════════════════════════════════════════════════════

src/providers/registry.ts
  createProviderRegistry()
    ├── closure state: config, generateTextFn,
    │     providerFactories map, configuredProviders cache
    │
    ├── creates arrow-function methods:
    │     isProviderConfigured(), generateText()
    │
    └── helpers (local to closure):
          ├── configuredProviders()           (which providers have API keys)
          ├── buildProviderOptions()          (ThinkingMode → provider options)
          ├── getProviderFactory()
          │     └── createProviderFactory()   (lazy, @ai-sdk provider instances)
          │
          and standalone exports:
                isProviderConfigured(),
                providerConfigurationErrorMessage()

src/providers/model-catalog.ts
  loadCatalog()
    ├── FileReader / FileWriter               (injected; testable)
    ├── fetchFn                               (globalThis.fetch by default)
    ├── validateCache()                       (CatalogJsonSchema)
    ├── fetchCatalog()                        (POST/GET https://models.dev/catalog.json)
    └── writeCacheFiles()                     (catalog.json + metadata.json)

  getCachedCatalog()
  clearCache()

src/providers/provider-map.ts
  getModelsDevProviderKey()                   (ProviderId → models.dev key)
  getProviderIdForModelsDevKey()              (inverse)
  isCatalogBackedProvider()                   (catalog vs passthrough)

src/providers/resolve-route.ts
  resolveRoute()
    ├── parseRouteId()                        (split on first "/")
    ├── lookupExactRoute()                    (configured catalog match)
    ├── lookupUnqualifiedRoute()              (unique provider-native match)
    ├── detectAmbiguous()                     (returns candidate route_id[])
    └── lookupPassthroughRoute()              (custom / gateway prefix)

  getRouteCandidates()                        (for ambiguity response)

src/providers/custom-url.ts
  customProviderBaseUrl()
    └── validateCustomApiUrl()
          ├── isLoopbackHost()
          ├── isBlockedHost()
          │     ├── isBlockedIpv4()
          │     └── isBlockedIpv6()
          └── normalizeHostname()


═══════════════════════════════════════════════════════════════════════════════
CONFIGURATION
═══════════════════════════════════════════════════════════════════════════════

src/config.ts
  loadConfig()
    ├── ensureConfigDirectories()
    │     └── ensurePrivateMode()
    ├── writeDefaultConfig()
    ├── resolveEnvVars()
    └── ChorusConfigSchema.parse()

  getConfigPaths()


═══════════════════════════════════════════════════════════════════════════════
UTILITIES
═══════════════════════════════════════════════════════════════════════════════

src/utils/logger.ts
  configureLogging()
    ├── config.getConfigPaths()
    ├── resolveLogLevel()
    ├── @logtape/logtape.configure()
    └── @logtape/file.getRotatingFileSink()

  wrapLogger() ──► logger (global)
  redactSecrets()

src/utils/files.ts
  embedFiles()
    ├── getAllowedRoots()
    ├── isAllowedPath()
    └── utils.estimateTokenCount()

src/utils.ts
  getErrorMessage()
  estimateTokenCount()


═══════════════════════════════════════════════════════════════════════════════
TYPE EXPORTS (no runtime calls)
═══════════════════════════════════════════════════════════════════════════════

src/types/providers.ts
  ProviderIdSchema, BrokerModelInfoSchema, ModelsListResponseSchema,
  ModelsListErrorSchema, ProviderListEntrySchema, CacheInfoSchema,
  CatalogJsonSchema, ProviderModelEntrySchema, CacheMetadataSchema  (Zod schemas)
  ProviderId, BrokerModelInfo, ModelsListResponse, ...                 (TS types)

src/types/consensus.ts
  Stance, ConsensusModelConfig, ParticipantResponse, ParticipantError,
  ConsensusRequest, ConsensusResult, ConsensusError                    (TS types)

src/types/tools.ts
  ToolError, Result<T, E>                                              (TS types)

src/types/index.ts
  re-exports providers.ts + tools.ts


═══════════════════════════════════════════════════════════════════════════════
PROMPTS (no runtime calls)
═══════════════════════════════════════════════════════════════════════════════

src/prompts/consensus.ts
  CONSENSUS_SYSTEM_PROMPT   (string constant, imported by consensus.ts + registry.ts)


═══════════════════════════════════════════════════════════════════════════════
COMPLETE CALL CHAIN: consensus --models "openai/gpt-5.2,anthropic/claude-sonnet-4-5" --prompt "p"
═══════════════════════════════════════════════════════════════════════════════

cli.runCli()
  └── config.loadConfig()
        └── resolveEnvVars() ──► ChorusConfigSchema.parse()

cli.runCli()
  └── commands/consensus.runConsensusCommand()
        ├── config.loadConfig()
        ├── utils/logger.configureLogging()
        ├── providers/model-catalog.loadCatalog()
        │     ├── FileReader / FileWriter
        │     ├── fetchFn (globalThis.fetch)
        │     └── → ~/.config/chorus/models-cache/{catalog,metadata}.json
        ├── providers/registry.createProviderRegistry(config)
        ├── providers/resolve-route.resolveRoute("openai/gpt-5.2")      ──► BrokerModelInfo
        ├── providers/resolve-route.resolveRoute("anthropic/claude-sonnet-4-5") ──► BrokerModelInfo
        │
        └── consensus.runConsensus({
              models: [{model:"openai/gpt-5.2"},{model:"anthropic/claude-sonnet-4-5"}],
              parallel: true,
              ...
            })
              │
              ├── embedFiles()            (if --files provided)
              │     ├── getAllowedRoots()
              │     ├── isAllowedPath()
              │     └── estimateTokenCount()
              │
              ├── runSettledWithConcurrency([a, b], maxConcurrency, queryModel)
              │     ├── queryModel(a)
              │     │     ├── buildConsensusPrompt("for", "p")
              │     │     └── registry.generateText("openai/gpt-5.2", prompt, systemPrompt)
              │     │           ├── buildProviderOptions()
              │     │           ├── getProviderFactory() ──► createProviderFactory()
              │     │           └── ai.generateText()     (Vercel AI SDK)
              │     │
              │     └── queryModel(b)
              │           ├── buildConsensusPrompt("against", "p")
              │           └── registry.generateText("anthropic/claude-sonnet-4-5", ...)
              │
              ├── buildSynthesisPrompt("p", successfulResponses)
              │     (only if --synthesis-model set and at least one participant succeeded)
              │
              └── registry.generateText(synthesisRoute, synthesisPrompt, ...)
```
