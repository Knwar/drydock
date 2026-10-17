---
name: asvs-card-review
description: Use when reviewing a single code change, diff or task for security against OWASP ASVS: picking the affected areas, chapters and level, checking the diff concretely, and reporting findings with severity, file:line, the related ASVS requirement and a fix.
---

# ASVS Change Review

Review one change (a diff, a task's worth of commits) for security, using the OWASP Application Security Verification Standard (ASVS) as the yardstick. The goal is a short list of real, located, fixable findings tied to ASVS, not a generic audit of the whole application.

## When to use

- A change touches anything security-relevant: login, sessions, permissions, user input, files, secrets, crypto, logging, external calls, dependencies, API endpoints
- A reviewer needs to decide whether a change is safe to merge
- Security acceptance criteria were set for a change and need verifying

Not for: whole-application audits or threat modeling a new design (see the threat-modeling skill), or API ergonomics and footgun design (see the sharp-edges skill).

## Core principles

1. **Review the diff, not the description.** Claims in commit messages or summaries are intent. Read the changed code and the code it calls.
2. **Scope by what the change touches.** Map the diff to areas, then to ASVS chapters. Do not run the entire standard against a three-line change.
3. **Every finding is located, explained and fixable.** File:line, what is wrong, how it can be exploited, which ASVS requirement it relates to, and the fix.
4. **Never invent ASVS requirement IDs.** Cite what you can verify; otherwise cite the chapter by name.
5. **Automated scans first, judgement second.** Scanners find the cheap, known problems; the review finds logic and authorization flaws scanners miss.
6. **Severity reflects exploitability and impact in this application**, not how scary the category sounds.

## About ASVS versions (read before citing)

- **ASVS 5.0** was released in 2025. It reorganised and renumbered the chapters relative to **4.0.3**, so a "V-number" means different things in the two versions (for example, V5 is "Validation, Sanitization and Encoding" in 4.0.3 but "File Handling" in 5.0).
- Always say which version you cite. Prefer 5.0 unless the project has committed to 4.0.3.
- **Do not guess requirement IDs** (like `V8.2.1`). If you have the ASVS document available, look up the exact requirement and cite its ID and wording. If you do not, cite the chapter by name, e.g. "ASVS 5.0, Authorization chapter", or simply "ASVS Authorization", and describe the requirement in your own words.
- ASVS 5.0 chapter names, for orientation (verify against the document when you have it): V1 Encoding and Sanitization; V2 Validation and Business Logic; V3 Web Frontend Security; V4 API and Web Service; V5 File Handling; V6 Authentication; V7 Session Management; V8 Authorization; V9 Self-contained Tokens; V10 OAuth and OIDC; V11 Cryptography; V12 Secure Communication; V13 Configuration; V14 Data Protection; V15 Secure Coding and Architecture; V16 Security Logging and Error Handling; V17 WebRTC.

## Choosing the level

ASVS defines three levels, each including the one below:

- **L1**: the baseline for most applications. Use by default.
- **L2**: for applications that handle sensitive data: personal data, health or financial data, credentials for other systems, business-critical transactions, or anything with meaningful abuse value. Most apps with user accounts and personal data should aim here.
- **L3**: for the most critical applications (high-value transactions, safety-critical, sensitive medical data). Only if the project says so.

State the level you reviewed against at the top of the report. When unsure, review at L1 and flag L2-relevant gaps as lower-severity recommendations.

## Method

1. **Understand the change.** Read the task's requirements and the full diff. Note new entry points (routes, handlers, jobs, CLI commands, message consumers), new data flows, new dependencies and config changes. Read surrounding code where the diff calls into it.
2. **Run automated checks first, if the project has them.** Typical categories: dependency audit (known-vulnerable packages), secret scanning (keys and tokens committed), static analysis (SAST), and the project's linters and tests. Interpret, do not paste:
   - Keep only results in or caused by this change; note pre-existing ones separately and briefly.
   - Confirm each hit by reading the code. Drop false positives with a one-line reason.
   - For dependency advisories, check whether the vulnerable function or path is reachable and whether a fixed version exists.
   - A clean scan is not a pass; it only means the cheap checks found nothing.
3. **Map the change to areas.** Mark every area the diff touches (see the table). A change can touch several.
4. **Pick the chapters and level.** Use the table to select the ASVS chapters for those areas, and the level from the section above.
5. **Check concretely.** For each selected area, walk the per-area checklist in `references/area-checklists.md` against the diff. Trace untrusted input from where it enters to where it is used (query, command, HTML, file path, URL, deserializer, log). For every new endpoint or operation, find the authentication and authorization check and confirm it covers the specific object being accessed.
6. **Write findings.** One entry per distinct problem, in the format below. Group duplicates of the same root cause.
7. **Decide.** Pass, pass with recommendations, or fail. Any Critical or High finding is a fail.

## Area → ASVS chapter map

| Area the change touches | ASVS 5.0 chapter(s) | ASVS 4.0.3 chapter(s) |
| --- | --- | --- |
| Authentication (login, signup, password reset, MFA, API keys) | Authentication; OAuth and OIDC if used | V2 Authentication |
| Session management (cookies, session tokens, logout, expiry) | Session Management; Self-contained Tokens for JWT-style tokens | V3 Session Management |
| Access control (roles, ownership checks, admin features, multi-tenant) | Authorization | V4 Access Control |
| Input validation and output encoding (forms, query params, HTML, SQL, shell, templates) | Encoding and Sanitization; Validation and Business Logic; Web Frontend Security for browser-side issues | V5 Validation, Sanitization and Encoding; V11 Business Logic |
| Cryptography (hashing, encryption, random values, signatures) | Cryptography | V6 Stored Cryptography |
| Secrets and configuration (env vars, keys, debug flags, headers, CORS) | Configuration; Secure Communication for TLS | V14 Configuration; V9 Communication |
| Error handling and logging | Security Logging and Error Handling | V7 Error Handling and Logging |
| Data protection (personal or sensitive data, caching, retention, exports) | Data Protection | V8 Data Protection |
| File handling (uploads, downloads, paths, archives, server-side fetches) | File Handling | V12 Files and Resources |
| API and web service (REST/GraphQL/RPC endpoints, webhooks) | API and Web Service | V13 API and Web Service |
| Dependencies and build (new packages, version bumps, scripts) | Secure Coding and Architecture | V14 Configuration; V10 Malicious Code |

Chapter placement of a given topic can differ between versions; confirm in the document before citing a chapter for an edge case.

## Finding format

```
[Severity] Short title
Location: path/to/file.ext:123 (and :140-152)
ASVS: 5.0, <chapter name> — <requirement ID and wording if verified; otherwise "chapter-level" plus your paraphrase>
Problem: what the code does wrong, in one or two sentences.
Exploit: who can do what, with what input, and what they gain.
Fix: the concrete change (code-level, not "add validation").
```

### Severity

| Severity | Meaning | Examples |
| --- | --- | --- |
| Critical | Remotely exploitable without special access; full compromise, mass data exposure, or auth bypass | SQL injection in a public endpoint; missing auth on an admin route; hard-coded production secret |
| High | Exploitable by a normal user or with modest effort; access to other users' data or privileged actions | IDOR on another user's records; stored XSS; reset token reusable or never expires |
| Medium | Needs specific conditions, or limited impact | Missing rate limit on login; verbose errors leaking internals; weak but salted hashing |
| Low | Defence in depth or hygiene; little direct impact | Missing security header with no current exploit path; overly broad log of non-sensitive data |
| Info | Observation or L2/L3 recommendation, not a defect at the chosen level | Suggest MFA for admin accounts at L1 |

## Report template

```
Security review: <change name>
ASVS version and level: 5.0, L1 (or L2: reason)
Areas touched: <list>
Automated checks: <which categories ran; summary; false positives dismissed>
Verdict: PASS | PASS WITH RECOMMENDATIONS | FAIL

Findings (most severe first):
<finding entries>

Checked and fine: <areas and the specific things verified, one line each>
Not checked / out of scope: <what you could not verify and why>
```

## Common failure modes

- Citing made-up requirement IDs, or 4.0.3 V-numbers as if they were 5.0
- Reviewing the whole standard instead of the change, burying real issues in boilerplate
- Trusting the summary ("added auth check") without finding the check in the diff
- Checking authentication but not object-level authorization (the user is logged in, but is it *their* record?)
- Flagging framework-handled issues as findings without checking that the framework protection is actually on (or reporting it missing when it is on)
- Pasting raw scanner output without triage
- Vague fixes ("sanitize input") instead of the specific change
- Ignoring the paths the diff calls into: the vulnerable code is often one hop away from the changed lines
- Missing secrets in tests, fixtures, example configs and logs

## Done means

- The ASVS version and level are stated, and the areas touched are listed
- Automated check results are triaged, not pasted
- Every finding has severity, file:line, the ASVS chapter (and verified requirement ID when available), the exploit, and a concrete fix
- No invented requirement IDs
- The "checked and fine" list shows what was actually verified
- The verdict follows from the findings: any Critical or High means fail
