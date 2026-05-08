import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Fastify from "fastify";
import {
  createSwitchboardRuntime,
  SWITCHBOARD_CHALLENGE_PATH,
  SWITCHBOARD_STATUS_PATH
} from "@proofcomputer/switchboard-sdk";

import { switchboardFastify } from "../src/index.js";

describe("switchboardFastify", () => {
  it("mounts challenge, status, and health routes with custom builders", async () => {
    const app = Fastify({ logger: false });
    const challengeEvents: unknown[] = [];
    const runtime = createSwitchboardRuntime({
      deploymentId: "deployment-fastify",
      initialConfig: {
        SESSION_ID: "session-fastify",
        JOB_ID: "job-fastify"
      }
    });
    await app.register(switchboardFastify, {
      runtime,
      additionalChallengePaths: ["/__proof/ingress/challenge", SWITCHBOARD_CHALLENGE_PATH],
      status: {
        build: () => ({ service: "unit-test" })
      },
      health: {
        build: () => ({ service: "unit-test" })
      },
      onChallenge: (event) => {
        challengeEvents.push(event);
      }
    });

    try {
      const challenge = await app.inject({
        method: "GET",
        url: `${SWITCHBOARD_CHALLENGE_PATH}?nonce=canonical`,
        headers: {
          "user-agent": "node-test"
        }
      });
      assert.equal(challenge.statusCode, 200);
      assert.equal(challenge.headers["cache-control"], "no-store");
      const challengeBody = challenge.json();
      assert.deepEqual(challengeBody, {
        sessionId: "session-fastify",
        nonce: "canonical",
        deploymentId: "deployment-fastify",
        jobId: "job-fastify",
        timestamp: challengeBody.timestamp
      });

      const compat = await app.inject({
        method: "GET",
        url: "/__proof/ingress/challenge?nonce=compat"
      });
      assert.equal(compat.statusCode, 200);
      assert.equal(compat.json().nonce, "compat");

      assert.equal(challengeEvents.length, 2);
      assert.deepEqual(
        {
          nonce: (challengeEvents[0] as any).nonce,
          path: (challengeEvents[0] as any).path,
          userAgent: (challengeEvents[0] as any).userAgent
        },
        {
          nonce: "canonical",
          path: SWITCHBOARD_CHALLENGE_PATH,
          userAgent: "node-test"
        }
      );
      assert.deepEqual(
        {
          nonce: (challengeEvents[1] as any).nonce,
          path: (challengeEvents[1] as any).path
        },
        {
          nonce: "compat",
          path: "/__proof/ingress/challenge"
        }
      );

      const missingNonce = await app.inject({
        method: "GET",
        url: SWITCHBOARD_CHALLENGE_PATH
      });
      assert.equal(missingNonce.statusCode, 400);
      assert.deepEqual(missingNonce.json(), { error: "missing_nonce" });

      for (const path of [SWITCHBOARD_STATUS_PATH, "/status"]) {
        const status = await app.inject({ method: "GET", url: path });
        const body = status.json();
        assert.equal(status.statusCode, 200);
        assert.equal(status.headers["cache-control"], "no-store");
        assert.equal(body.ok, true);
        assert.equal(body.sessionId, "session-fastify");
        assert.equal(body.jobId, "job-fastify");
        assert.equal(body.deploymentId, "deployment-fastify");
        assert.equal(body.service, "unit-test");
        assert.equal(typeof body.timestamp, "number");
      }

      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200);
      assert.deepEqual(health.json(), { ok: true, service: "unit-test" });
    } finally {
      await app.close();
    }
  });

  it("can disable health and de-duplicates status aliases", async () => {
    const app = Fastify({ logger: false });
    await app.register(switchboardFastify, {
      runtime: createSwitchboardRuntime({
        initialConfig: {
          SESSION_ID: "session-fastify"
        }
      }),
      status: { path: "/status" },
      health: false
    });

    try {
      const status = await app.inject({ method: "GET", url: "/status" });
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().sessionId, "session-fastify");

      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});
