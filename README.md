# Switchboard Fastify Adapter

Fastify helpers for Acurast jobs deployed through Switchboard.

This package is public for GitHub installs during the private beta. It is not
published on npmjs.com yet.

## Install

```sh
npm install github:proof-computer/switchboard-fastify#v0.1.3 fastify
npm install -D typescript tsx @types/node
```

Use `#main` only when intentionally testing unreleased changes. npmjs.com
publishing is prepared but not active yet.

## App

```ts
import { serveSwitchboardFastify } from "@proofcomputer/switchboard-fastify";

void serveSwitchboardFastify(async (app) => {
  app.get("/", async (_request, reply) => {
    reply.type("text/html");
    return "<h1>Switchboard Fastify</h1><p>ok</p>";
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
```

For apps that already own their Fastify lifecycle, register the plugin
directly with `switchboardFastify`.
