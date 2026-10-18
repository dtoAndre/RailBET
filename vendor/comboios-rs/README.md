# comboios-rs

Unofficial Rust client for Portuguese train data (CP / Infraestruturas de Portugal), with a REST API server, MCP server, and SvelteKit web UI.

## Workspace

| Crate | Description |
|---|---|
| `comboios-core` | Core library. Wraps the CP API Gateway and the Infraestruturas de Portugal public API. Handles credential fetching, caching, request routing, and mapping raw responses to typed domain models (`TrainJourney`, `StationBoard`, `JourneyStop`, etc.). |
| `comboios-server` | Axum HTTP server that exposes `comboios-core` as a REST API. Rotates CP credentials automatically in the background. |
| `comboios-mcp` | MCP (Model Context Protocol) server. Exposes station search, timetables, and train journeys as tools consumable by AI assistants. |
| `comboios-ui` | SvelteKit frontend. Station search, live departure/arrival boards, and a stop-by-stop train journey view with real-time delay indicators. |

## Running

The repo ships a Nix dev shell with Rust, bun, Node and [just](https://just.systems):

```bash
nix develop        # or: direnv allow (uses .envrc)
just               # list tasks
just dev           # API server on :3000 + UI on :5173
just check         # everything CI runs
```

Or run the pieces by hand:

**API server**
```bash
cargo run -p comboios-server
```

**Web UI**
```bash
cd comboios-ui
bun install && bun run dev
```

**MCP server**
```bash
cargo run -p comboios-mcp
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/ping` | Health check |
| GET | `/stations?query=Lisboa` | Search stations by name |
| GET | `/stations/timetable/{id}` | Live departure/arrival board |
| GET | `/trains/{id}/journey` | Train journey with stop-by-stop status |
| GET | `/diagnostics` | CP and IP API reachability |
| GET | `/refresh` | Force CP credential rotation |

## Configuration

### API Server

All settings have defaults and can be overridden via environment variables.

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3000` | Port |
| `RUST_LOG` | `comboios_server=debug,tower_http=debug` | Log filter |
| `REQUEST_TIMEOUT_SECS` | `30` | Per-request timeout |
| `DIAGNOSTICS_TIMEOUT_MS` | `5000` | Health-check probe timeout |
| `CREDENTIAL_REFRESH_SECS` | `3300` | CP credential rotation interval |
| `CORS_MAX_AGE_SECS` | `86400` | CORS pre-flight max age |
| `CP_API_URL` | `https://api-gateway.cp.pt/cp/services/travel-api` | CP base URL |
| `IP_API_URL` | `https://www.infraestruturasdeportugal.pt` | IP base URL |

### Web UI (Docker)

| Variable | Default | Description |
|---|---|---|
| `API_PROXY_PASS` | `http://server:3000` | Backend URL nginx proxies API requests to |

## Library Usage

```toml
[dependencies]
comboios-core = { path = "comboios-core" }
```

```rust
use comboios_core::Comboios;

#[tokio::main]
async fn main() -> Result<(), comboios_core::Error> {
    let client = Comboios::new().await?;

    let stations = client.search_stations("Porto").await?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let board = client.get_station_timetable("94-31039", &today, None).await?;
    let journey = client.get_train_journey("530", &today).await?;

    Ok(())
}
```

`Comboios::new()` scrapes live credentials from `cp.pt` on startup and caches them. The server rotates them automatically every 55 minutes.

## Data Sources

- **CP API Gateway** (`api-gateway.cp.pt`) — timetables, train journeys, real-time delays. Credentials are fetched automatically from `cp.pt`.
- **Infraestruturas de Portugal** (`infraestruturasdeportugal.pt`) — public API, used as fallback for train journey data.

Both are unofficial endpoints. They may change without notice.

## Docker

**Server only**

```bash
docker run -p 3000:3000 ghcr.io/caiocdcs/comboios-server:latest
```

**Server + UI (docker-compose)**

```bash
docker compose up
```

The API server runs on port 3000 and the UI on port 8080 by default.
Override with environment variables:

| Variable | Default | Description |
|---|---|---|
| `SERVER_PORT` | `3000` | API server host port |
| `UI_PORT` | `8080` | Web UI host port |
| `RUST_LOG` | `comboios_server=info,tower_http=info` | Log filter |
| `API_PROXY_PASS` | `http://server:3000` | Backend URL the UI nginx proxies API to |

The UI uses nginx to proxy API requests (`/stations`, `/trains`, `/ping`, `/diagnostics`, `/refresh`) to the backend. This means the frontend always talks to its own origin -- no build-time API URL needed. Set `API_PROXY_PASS` to change the backend target.

## Install on your phone

The UI is an installable web app (PWA): favourite stations are pinned to the
home screen, and the app shell plus the last boards you loaded keep working
on a flaky connection.

Browsers only enable this over **HTTPS** (service workers and the Android
install prompt need a secure origin), so plain `http://192.168.x.x:8080` won't
do. Put a reverse proxy with a TLS certificate (Caddy, Traefik, nginx) in front
of port 8080, then open its URL on the phone:

- **iOS (Safari):** Share → Add to Home Screen
- **Android (Chrome):** menu → Install app

## Development

```bash
just check   # fmt, clippy -D warnings, tests, UI type-check and build (same as CI)
just test    # Rust tests only
just fmt
```
