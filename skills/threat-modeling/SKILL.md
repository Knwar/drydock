---
name: threat-modeling
description: Use when threat modeling a system or feature with STRIDE, turning identified threats into testable security requirements, or mapping threats to security controls to find gaps, prioritize mitigations and plan defense in depth.
---

# Threat Modeling

Systematic threat identification using the STRIDE methodology, then turning the threats into actionable security requirements and mapping them to controls for effective security planning.

The three parts run in order: **identify threats (STRIDE) → extract requirements → map mitigations**.

## When to Use This Skill

- Starting new threat modeling sessions
- Analyzing existing system architecture
- Reviewing security design decisions
- Creating threat documentation
- Converting threat models to requirements
- Writing security user stories, test cases and acceptance criteria
- Prioritizing security investments and creating remediation roadmaps
- Validating control coverage and designing defense-in-depth
- Compliance and audit preparation

## Part 1: STRIDE Analysis

### 1. STRIDE Categories

```
S - Spoofing       → Authentication threats
T - Tampering      → Integrity threats
R - Repudiation    → Non-repudiation threats
I - Information    → Confidentiality threats
    Disclosure
D - Denial of      → Availability threats
    Service
E - Elevation of   → Authorization threats
    Privilege
```

### 2. Threat Analysis Matrix

| Category            | Question                                  | Control Family |
| ------------------- | ----------------------------------------- | -------------- |
| **Spoofing**        | Can attacker pretend to be someone else?  | Authentication |
| **Tampering**       | Can attacker modify data in transit/rest? | Integrity      |
| **Repudiation**     | Can attacker deny actions?                | Logging/Audit  |
| **Info Disclosure** | Can attacker access unauthorized data?    | Encryption     |
| **DoS**             | Can attacker disrupt availability?        | Rate limiting  |
| **Elevation**       | Can attacker gain higher privileges?      | Authorization  |

### 3. STRIDE per Data Flow Diagram Element

Model the system as a data flow diagram (external entities, processes, data stores, data flows) with trust levels, then apply the categories that fit each element type:

| Element type    | Applicable categories |
| --------------- | --------------------- |
| External entity | S, R                  |
| Process         | S, T, R, I, D, E      |
| Data store      | T, R, I, D            |
| Data flow       | T, I, D               |

Pay most attention to data flows that **cross a trust boundary** (source and destination have different trust levels), largest trust difference first, and flag any such flow that is **not encrypted**.

### 4. Risk Scoring

Score each threat as **Impact × Likelihood**, each on 1 (Low) to 4 (Critical), giving 1–16:

| Score  | Risk level |
| ------ | ---------- |
| ≥ 12   | Critical   |
| 6–11   | High       |
| 3–5    | Medium     |
| 1–2    | Low        |

The same score sets requirement priority in Part 2.

## Part 2: Security Requirement Extraction

### 1. Requirement Categories

```
Business Requirements → Security Requirements → Technical Controls
         ↓                       ↓                      ↓
  "Protect customer    "Encrypt PII at rest"   "AES-256 encryption
   data"                                        with KMS key rotation"
```

### 2. Security Requirement Types

| Type               | Focus                   | Example                               |
| ------------------ | ----------------------- | ------------------------------------- |
| **Functional**     | What system must do     | "System must authenticate users"      |
| **Non-functional** | How system must perform | "Authentication must complete in <2s" |
| **Constraint**     | Limitations imposed     | "Must use approved crypto libraries"  |

### 3. Requirement Attributes

| Attribute        | Description                 |
| ---------------- | --------------------------- |
| **Traceability** | Links to threats/compliance |
| **Testability**  | Can be verified             |
| **Priority**     | Business importance         |
| **Risk Level**   | Impact if not met           |

### 4. STRIDE to Security Domain

| STRIDE category        | Security domains                      |
| ---------------------- | ------------------------------------- |
| Spoofing               | Authentication, session management    |
| Tampering              | Input validation, data protection     |
| Repudiation            | Audit logging                         |
| Information disclosure | Data protection, cryptography         |
| Denial of service      | Availability, input validation        |
| Elevation of privilege | Authorization                         |

## Part 3: Threat Mitigation Mapping

### 1. Control Categories

```
Preventive ────► Stop attacks before they occur
   │              (Firewall, Input validation)
   │
Detective ─────► Identify attacks in progress
   │              (IDS, Log monitoring)
   │
Corrective ────► Respond and recover from attacks
                  (Incident response, Backup restore)
```

### 2. Control Layers

| Layer           | Examples                             |
| --------------- | ------------------------------------ |
| **Network**     | Firewall, WAF, DDoS protection       |
| **Application** | Input validation, authentication     |
| **Data**        | Encryption, access controls          |
| **Endpoint**    | EDR, patch management                |
| **Process**     | Security training, incident response |

### 3. Defense in Depth

```
                    ┌──────────────────────┐
                    │      Perimeter       │ ← Firewall, WAF
                    │   ┌──────────────┐   │
                    │   │   Network    │   │ ← Segmentation, IDS
                    │   │  ┌────────┐  │   │
                    │   │  │  Host  │  │   │ ← EDR, Hardening
                    │   │  │ ┌────┐ │  │   │
                    │   │  │ │App │ │  │   │ ← Auth, Validation
                    │   │  │ │Data│ │  │   │ ← Encryption
                    │   │  │ └────┘ │  │   │
                    │   │  └────────┘  │   │
                    │   └──────────────┘   │
                    └──────────────────────┘
```

### 4. Gap Rules

For each threat, check its mapped controls:

- **Unmapped threat**: no control at all. Always a gap.
- **Insufficient coverage**: coverage below 50% (see the coverage formula in the mitigation reference).
- **No defense in depth**: fewer than 2 distinct layers among controls that are at least partly implemented.
- **No control diversity**: fewer than 2 distinct control types (preventive/detective/corrective) among implemented controls.

Fix gaps on Critical-impact threats first, then High.

## Templates and detailed worked examples

- `references/stride-threat-model.md`: full STRIDE threat model document template, STRIDE question list per category, common mitigations per category, and threats per interaction type. Read it when running a STRIDE session.
- `references/security-requirements.md`: requirement record fields, requirement patterns, acceptance criteria and test cases per STRIDE category, security user story and epic templates. Read it when turning threats into requirements.
- `references/mitigation-mapping.md`: mitigation model, coverage scoring, a starter control library, roadmap rules, and mitigation and control-test report templates. Read it when mapping threats to controls.

## Best Practices

### Do's

- **Cover all perspectives** - Security, dev, and ops
- **Be systematic** - Cover all STRIDE categories
- **Prioritize realistically** - Focus on high-impact threats
- **Update regularly** - Threat models are living documents
- **Use visual aids** - DFDs help communication
- **Trace to threats** - Every requirement should map to threats
- **Be specific** - Vague requirements can't be tested
- **Include acceptance criteria** - Define "done"
- **Consider compliance** - Map to frameworks early
- **Map all threats** - No threat should be unmapped
- **Layer controls** - Defense in depth is essential
- **Mix control types** - Preventive, detective, corrective
- **Track effectiveness** - Measure and improve

### Don'ts

- **Don't skip categories** - Each reveals different threats
- **Don't assume security** - Question every component
- **Don't ignore low-probability** - High-impact threats matter
- **Don't stop at identification** - Follow through with mitigations
- **Don't be generic** - "Be secure" is not a requirement
- **Don't skip rationale** - Explain why it matters
- **Don't ignore priorities** - Not all requirements are equal
- **Don't forget testability** - If you can't test it, you can't verify it
- **Don't rely on single controls** - Single points of failure
- **Don't ignore cost** - ROI matters
- **Don't skip testing** - Untested controls may fail
- **Don't set and forget** - Controls degrade over time
- **Don't ignore people/process** - Technology alone isn't enough
