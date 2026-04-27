# Supabase + Node.js Memory Chat API

A runnable reference implementation for:
- short-term memory (recent message window),
- long-term memory (user profile),
- summary memory (conversation summary refresh).

## 1) Create tables in Supabase
Run SQL in `schema.sql` using the Supabase SQL editor.

## 2) Prepare environment variables
Copy `.env.example` to `.env` and fill values:

```bash
cp .env.example .env
```

## 3) Install and run

```bash
npm install
npm start
```

Server starts at `http://localhost:8787` by default.

## 4) Test request

```bash
curl -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "external_user_id": "user_001",
    "message": "我刚到东京第二天，区役所住址登记需要带什么？"
  }'
```

Use the returned `conversation_id` for subsequent turns:

```bash
curl -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "external_user_id": "user_001",
    "conversation_id": "<PUT_THE_ID_HERE>",
    "message": "那国民健康保险要一起办吗？"
  }'
```

## Notes
- Keep API keys on the server side only.
- This is a baseline example; add authentication + rate limiting before production.
