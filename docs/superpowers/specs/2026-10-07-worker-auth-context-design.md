# Worker auth context design

## Goal and evidence

Reduce repeated Better Auth initialization when a Cookie is present without caching sessions or sharing request-owned I/O. Private production samples on 2026-10-07 were 52.908ms for unrelated Cookie and 17.783ms for invalid signed-session Cookie, both returning 401 without password hashing. Anonymous admission is already optimized. These observations motivate a local experiment, not approval of Workers Free CPU or public cutover.

## Design

Keep one initialized Better Auth engine per Worker isolate, replacing the sole entry when effective auth configuration or environment changes. Compare an immutable snapshot of every BetterAuthConfig field, including the exact database credential/target string and email configuration. Never log or serialize these values as a key. Old in-flight operations retain their own entry; no unbounded map.

The engine uses a stable dependency bridge backed by AsyncLocalStorage. Each handler/getSession call gets a fresh live scope containing its own pool, email service and background runner. A stable Kysely PostgresPool facade resolves the current pool at each checkout, not at driver initialization. Wrap clients with owner/liveness guards. Queries, transaction BEGIN/COMMIT/ROLLBACK and release stay on the captured client; release is idempotent and remains legal for cleanup after the scope closes. Late checkout must release its client and fail. Queries after release, outside the owning scope or after completion fail closed. Cursor queries are unsupported and rejected. The facade has no Client constructor or credentials in options; end is a no-op and never ends an invocation's real pool.

Email methods and background registration resolve the current live scope before starting work. Already-started background promises can finish on their own runner; late callbacks cannot start new I/O. On completion clear the scope's dependency references as well as marking it closed, so pending descendant async resources cannot keep request pools/email/runners alive. No AsyncLocalStorage.disable/enterWith. Only actual Promises are used.

Initialize the engine and await its context and existing schema check inside the first operation's scope. Concurrent operations share readiness, but then dispatch in their own scope. Evict failed initialization only if the failed entry is still current. Session resolution failures do not discard a healthy engine. Better Auth's own schema validation/invalidation and per-request state remain enabled. Config/credential changes create a new engine. Node/Fastify keeps the original composition; Worker overrides remain honored.

## Constraints

- No deploy, public ingress, DNS, main merge, Paid upgrade, Stripe Live or legacy retirement in this experiment.
- No global real Pool, session/user/authorization cache, weaker CAPTCHA/cookies/password hashing, or schema changes.
- Preserve Better Auth 1.7.6, Kysely 0.29.6 and current pg/Hyperdrive; no dependency installation.
- All work stays in D:/Projetos and production stays private at db882acc-fdfb-41ce-a783-04ec87954872.

## Validation and limits

Use real AsyncLocalStorage and Kysely with synthetic network-level pool clients for concurrent requests, successful and failed transactions, checkout failure, late checkout, escaped/released client and email ownership. Exercise the bridge in workerd, not only Node. Test cache reuse, config replacement, failed initialization/retry and stale failure; use real Better Auth for session revocation and invalid Cookie controls. Full API tests, TypeScript build, workerd suite and Worker dry-run must stay green.

Local tests do not prove Neon SQL integration, browser cookie/CORS pairing, provider delivery, password/login CPU or Free CPU suitability. Those remain Stage 13 private remote gates. No deployment is part of this plan.
