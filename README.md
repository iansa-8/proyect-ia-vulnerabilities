# AI Modernization Platform

Plataforma local para analizar y modernizar repositorios existentes con controles deterministas, razonamiento acotado y revisión humana.

> La plataforma hace todo lo determinístico. La IA razona solo cuando aporta valor. El agente es un escalamiento, no el flujo normal.

## Estructura

```text
apps/web/           React + Vite + TypeScript
apps/local-agent/   NestJS + REST/WebSocket + SQLite (sql.js)
packages/core/      Tipos de dominio y eventos
packages/pipeline/  Contrato del motor de pipeline
packages/providers/ Interfaces Agent / Indexer / Quality / LLM
packages/validators/Contratos de validación
packages/scanners/  Contrato SecurityScanner (futuro)
packages/reporting/ Contrato de reporting
packages/policies/  Contrato de políticas
```

## Estado actual

La fase activa es **Sonar Remediation**. El flujo principal es:

```text
proyecto
→ indexación
→ análisis Sonar
→ snapshot BEFORE
→ contexto mínimo
→ routing local / LLM / manual
→ patch estructurado
→ aprobación humana
→ aplicación y validación
→ análisis AFTER
→ comparación y revisión
```

Componentes ya implementados:

- `CommandExecutionService` como única abstracción de procesos.
- `SonarQualityProvider` y `NodeSonarAnalyzer` desacoplados por contratos.
- Baseline Sonar y snapshots BEFORE/AFTER.
- `CodebaseMemoryIndexerProvider` detrás de `IndexerProvider`.
- `QualityIssueContextService` para reducir contexto.
- `RemediationRuleRegistry`, `RemediationRouter` y remediadores deterministas.
- `StructuredPatchEngine` para ediciones exactas revisables.
- `LiteLLMProvider` para propuestas LLM sin navegación agentic.
- `CodexAgentProvider` reservado para escalamiento explícito.

## Puertos

| Servicio | Puerto | Variable |
|---|---:|---|
| Backend NestJS | 3001 | `PORT` |
| Frontend Vite | 5173 | Vite default |

CORS: `http://localhost:5173` → `http://localhost:3001`  
SQLite: `data/app.sqlite` (configurable con `SQLITE_PATH`).

## Arranque local

```powershell
npm install
npm run dev
```

También:

```powershell
npm run dev:agent
npm run dev:web
```

Health: `http://localhost:3001/api/health`  
UI: `http://localhost:5173`

## Verificación

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

## Variables relevantes

Copiar `.env.example` a `.env`. No guardar secretos en el repositorio.

- `SONAR_URL` y `SONAR_TOKEN`: servidor y credencial global.
- `SONAR_ALLOWED_ORIGINS`: orígenes extra permitidos para overrides por proyecto.
- `SONAR_SCANNER_AUTH_MODE`: `legacy-login` o `token-env`.
- `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LITELLM_MODEL`: gateway LLM.
- `CODEX_COMMAND`: provider de escalamiento.

Los overrides de URL de calidad no pueden redirigir el token a un origen no permitido.

## Fuera de la fase actual

No se añadirá todavía:

```text
Dependency Security
Dockerfile / Image Security
```

Se añadirán únicamente cuando Sonar Remediation esté cerrada y validada.
