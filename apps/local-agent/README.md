# @amp/local-agent

Backend local NestJS del AI Modernization Platform.

- REST bajo `/api`
- WebSocket (Socket.IO) con eventos tipados
- Persistencia SQLite mediante `sql.js`
- Pipeline Engine secuencial con persistencia de runs y steps
- `CommandExecutionService` como única ejecución de procesos
- Providers reales detrás de contratos: Sonar, Codebase Memory, LiteLLM y Codex
- Sonar baseline, snapshots BEFORE/AFTER y remediación revisable

## Flujos principales

```text
quality-analysis
sonar-baseline
quality-fix-proposal
quality-fix-application
```

Las propuestas locales o LLM que incluyen un `StructuredPatch` se aplican mediante `StructuredPatchEngine`. El primer remediador exacto es `typescript:S2933`; las reglas registradas sin patch exacto fallan de forma segura y no invocan un agente automáticamente. Codex queda para propuestas legacy o escalamiento explícito.

## Seguridad local

- El contexto del repositorio y el parche se validan antes de aplicar.
- Las rutas de patch son relativas, deben permanecer dentro del proyecto y no pueden tocar archivos sensibles.
- Las precondiciones se vuelven a comprobar inmediatamente antes de escribir.
- Los origins de URL Sonar usados por overrides deben estar en `SONAR_URL` o `SONAR_ALLOWED_ORIGINS`.
- `windowsVerbatimArguments: true` se conserva en la ejecución de comandos Windows.

## Comandos

```powershell
npm run start:dev -w @amp/local-agent
npm test -w @amp/local-agent
npm run typecheck -w @amp/local-agent
```
