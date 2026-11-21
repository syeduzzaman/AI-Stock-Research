# AI Stock Research

A personal stock research workspace with watchlists, manual holdings, configurable multi-agent analysis, and cited filing excerpts.

Use **English** or **Deutsch** at the top of the dashboard to switch languages. The browser remembers your choice. New AI analyses save explanations in both languages in one run. The German view labels older English-only AI explanations and English filing excerpts.

## Run with Docker

Start Docker Desktop with Linux containers and run this command from the project folder.

~~~powershell
docker compose up --build
~~~

Open the address shown in the dashboard logs and choose **Open demo**. The default is [http://127.0.0.1:8082](http://127.0.0.1:8082). If port 8082 is in use, add `DASHBOARD_PORT=8083` to `.env` and open [http://127.0.0.1:8083](http://127.0.0.1:8083). To change ports for one PowerShell session, set `$env:DASHBOARD_PORT = '8083'` before running Compose.

Compose runs the dashboard and its MCP subprocess in one container. The health check pings the MCP server, and the published port listens on the host's loopback address. Run `docker compose down` to stop the app. The named volume retains your demo workspace when you replace the container. The container starts with its own SQLite database when you first switch from a direct Node.js launch.

The demo works without an `.env` file. Compose reads it at startup when you add one for account settings or live data. Apply configuration edits with `docker compose up -d`.

## Run directly with Node.js

Install Node.js 24 or newer. From the project folder:

~~~powershell
node --env-file-if-exists=.env src/server.mjs
~~~

Open [http://127.0.0.1:8082](http://127.0.0.1:8082) and choose **Open demo**. The demo needs no accounts, packages, or API keys. It uses synthetic closing prices, financial numbers, and filing excerpts. The same browser session can reopen watchlists, manual positions, analysis preferences, and results stored in local SQLite.

Try searching for **MU**, selecting **3M** and **5 agents**, then running an analysis. Expand an agent’s sources to read the evidence. **Analysis history** saves completed runs. Use **Add to watchlist** from the stock card or result to follow its closing price and reopen the latest analysis. Use **Add holding** to enter shares you own and the average cost per share in USD. The **Portfolio** shows cost basis, market value, and unrealized gain or loss.

Run an analysis again with the same settings and open **Compare with previous analysis** in the result. It compares the nearest earlier matching run in your saved history and highlights score changes, newly cited sources, and updated data snapshots.

## Connect a dedicated Supabase project

1. In the new project, run [the workspace migration](supabase/migrations/202611200001_workspace.sql) in the SQL Editor.
2. Use [.env.example](.env.example) to add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` to `.env`. Set them to the project URL and its publishable key.
3. In Auth URL Configuration, set the Site URL to the dashboard address. The app also requests this address when sending confirmation links. Use `http://127.0.0.1:8083` if your Compose port is 8083. Enable email and keep **Confirm email** on in the email provider settings.
4. Restart the app. Choose **Create account** and enter a username, email, and password. Open the confirmation link and then sign in with your email and password.

Supabase's default email delivery is for testing with project team members. To send confirmation emails to other addresses, connect a [custom SMTP sender](https://supabase.com/docs/guides/auth/auth-smtp). For numeric codes, include `{{ .Token }}` in the **Confirm signup** [email template](https://supabase.com/docs/guides/auth/auth-email-templates) and set `SUPABASE_EMAIL_CONFIRMATION=code`. New free projects need custom SMTP to edit this template.

Supabase Auth manages credentials. The app stores a hashed opaque session identifier and server-side tokens in SQLite. In hosted mode, Supabase stores watchlists, holdings, preferences and run history, and uses the signed-in user's token and PostgreSQL row-level security to check ownership. Deploy behind HTTPS with PUBLIC_ORIGIN set and keep the SQLite directory private and persistent. The backend is designed for one process. The first release includes sign-up and sign-in. Add an in-app password recovery flow before opening registration publicly.

## Enable market data and model APIs

- Set `MARKET_DATA_MODE=live` and `TWELVE_DATA_API_KEY` in `.env`. Set `SEC_USER_AGENT` to your app name and contact email, for example `"Stock Research Dashboard your-email@example.com"`. Live mode requests daily closing prices from Twelve Data and reads SEC EDGAR company facts and recent filings for the covered US issuers.
- Set both the API key and model ID for each provider you want to enable. The model selector shows available integrations. Local demo analysis works with synthetic data and no model key. Live analysis requires an enabled model.
- Keep all provider credentials in the server environment or local .env file. When a configured model runs, it receives the ticker, horizon, and public research evidence used by the agent. Portfolio holdings and account details stay in the workspace.

In this version the catalog is a 12-stock sample, with Nasdaq-100 and S&P 500 filters. The workspace tracks manually entered long positions with an average cost and unrealized value in USD.

## Architecture

- **MCP**. The Node app launches a separate stdio MCP server, initializes protocol version 2025-11-25, discovers tools, and calls the declared read-only tools through JSON-RPC. The server exposes get_price_history, get_company_financials, and search_filings.
- **Retrieval**. The server extracts passages from recent filings, ranks them against each specialist's query, and sends matching excerpts with source IDs, dates and links to the analysis backend. The first version uses lexical retrieval.
- **Agents**. Three or five specialists run independently. Each agent receives the evidence for its role and scores the selected horizon on a shared 0–100 scale. The backend validates model output and references and averages the scored agents. The UI shows score coverage and range.
- **Scoring**. The overall score averages agents with usable results. The interface labels the direction and strength of the evidence on a 0–100 scale. The horizon controls the question sent to each model and the price-change window. Portfolio values use the latest available close shown on each row.

The local demo and end-to-end test do not require external services. The hosted configuration uses these service references:

- [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-11-25)
- [Supabase password authentication](https://supabase.com/docs/guides/auth/passwords)
- [Twelve Data API](https://twelvedata.com/docs)
- [SEC EDGAR Data APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

## Verify

~~~powershell
node --test
~~~

The tests cover retrieval, session separation, personal watchlists and holdings, preferences, MCP calls, score aggregation, and reopening analysis history.
