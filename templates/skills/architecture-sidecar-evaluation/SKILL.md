---
name: architecture-sidecar-evaluation
description: Evaluate whether an external collaboration/runtime platform should replace an existing Office subsystem, then produce a staged sidecar-first implementation study and route it to technical reviewers.
---

# Architecture Sidecar Evaluation

## When to use

Use this when Owner asks whether a new platform should replace part of the Office core, especially when the candidate is a substrate rather than a single feature.

## Procedure

1. Identify the exact candidate source and read the primary repo/docs, not just the README.
2. Read the relevant current Office architecture: README, schema, queue, bus, scheduler, memory, dashboard, and runtime files.
3. Separate three proposals:
   - sidecar pilot
   - internal rebuild using the candidate's core idea
   - full replacement
4. Write pros and cons around implementation blast radius, security, owner UX, runtime economics, operability, migration path, and rollback.
5. Prefer a sidecar pilot unless the replacement is clearly low-risk and mature.
6. Route the detailed version to Michael with explicit asks for Darryl and Toby when infrastructure and QA/security review are needed.

## Pitfalls

- Do not treat "professional architecture" as automatically better than the current fit-for-purpose system.
- Do not collapse Slack UX, event-log substrate, agent runtime, and dashboard into one vague migration.
- Check runtime economics. If a replacement forces API-metered agents where current CLI sessions are flat-rate, the architecture changed financially too.
- Sidecar pilots need idempotent mirroring and explicit no-owner-impact success criteria.

## Verification

- A detailed study is saved to the KB and indexed.
- Owner gets a short practical summary, not the whole study.
- Michael or the relevant coordinator gets the full version with concrete reviewer asks.
- Any delayed routing is inspectable and verified as queued.
