# Security requirement extraction — templates and worked examples

## Template 1: Security Requirement Record

Each requirement carries:

| Field | Content |
| --- | --- |
| id | `SR-001`, `SR-002`, ... |
| title | Short imperative ("Enforce authorization for order API") |
| description | What must be true |
| type | Functional, non-functional or constraint |
| domain | Authentication, authorization, data protection, audit logging, input validation, error handling, session management, cryptography, network security, availability |
| priority | Critical, High, Medium, Low (from the threat's risk score) |
| rationale | Why it matters; usually "Mitigates threat: <threat title>" |
| acceptance criteria | Checkable statements |
| test cases | How each criterion is verified |
| threat refs | Threat ids it mitigates (S1, T2, ...) |
| compliance refs | Framework controls it supports, if any (look up the exact control ids in the framework; do not guess them) |
| dependencies | Other requirements it relies on |
| status, owner | Draft / accepted / implemented / verified; who owns it |

Keep a **traceability matrix**: threat id → requirement ids. Every threat should appear in it.

## Template 2: Threat-to-Requirement Extraction

For each threat, take its target (the component or data it attacks), set priority from Impact × Likelihood (1–4 each; ≥12 Critical, ≥6 High, ≥3 Medium, else Low), and derive requirements from its STRIDE category.

### Spoofing
Domains: authentication, session management.
- **Implement strong authentication for {target}**: Ensure {target} authenticates all users before granting access
- **Validate identity tokens for {target}**: All authentication tokens must be cryptographically verified
- **Implement session management for {target}**: Sessions must be securely managed with proper expiration

Acceptance criteria: users must authenticate before accessing {target}; authentication failures are logged and monitored; multi-factor authentication is available for sensitive operations.
Test cases: unauthenticated access to {target} is denied; invalid credentials are rejected; session tokens cannot be forged.

### Tampering
Domains: input validation, data protection.
- **Validate all input to {target}**: All input must be validated against expected formats
- **Implement integrity checks for {target}**: Data integrity must be verified using cryptographic signatures
- **Protect {target} from modification**: Implement controls to prevent unauthorized data modification

Acceptance criteria: all input to {target} is validated; data integrity is verified before processing; modification attempts trigger alerts.
Test cases: invalid input to {target} is rejected; tampered data is detected and rejected; SQL injection attempts are blocked.

### Repudiation
Domain: audit logging.
- **Log all security events for {target}**: Security-relevant events must be logged for audit purposes
- **Implement non-repudiation for {target}**: Critical actions must have cryptographic proof of origin
- **Protect audit logs for {target}**: Audit logs must be tamper-evident and protected

Acceptance criteria: all actions on {target} are logged with user identity; logs cannot be modified by regular users; log retention meets compliance requirements.
Test cases: security events are logged; logs include sufficient detail for forensics; log integrity is protected.

### Information Disclosure
Domains: data protection, cryptography.
- **Encrypt sensitive data in {target}**: Sensitive data must be encrypted at rest and in transit
- **Implement access controls for {target}**: Data access must be restricted based on need-to-know
- **Prevent information leakage from {target}**: Error messages and logs must not expose sensitive information

Acceptance criteria: sensitive data in {target} is encrypted; access to sensitive data is logged; error messages do not reveal sensitive information.
Test cases: {target} data is encrypted in transit; {target} data is encrypted at rest; error messages are sanitized.

### Denial of Service
Domains: availability, input validation.
- **Implement rate limiting for {target}**: Requests must be rate-limited to prevent resource exhaustion
- **Ensure availability of {target}**: System must remain available under high load conditions
- **Implement resource quotas for {target}**: Resource consumption must be bounded and monitored

Acceptance criteria: rate limiting is enforced on {target}; system degrades gracefully under load; resource exhaustion triggers alerts.
Test cases: rate limiting on {target} works correctly; system handles burst traffic gracefully; resource limits are enforced.

### Elevation of Privilege
Domain: authorization.
- **Enforce authorization for {target}**: All actions must be authorized based on user permissions
- **Implement least privilege for {target}**: Users must only have minimum necessary permissions
- **Validate permissions for {target}**: Permission checks must be performed server-side

Acceptance criteria: authorization is checked for all {target} operations; users cannot access resources beyond their permissions; privilege changes are logged and monitored.
Test cases: unauthorized access to {target} is denied; privilege escalation attempts are blocked; IDOR vulnerabilities are not present.

## Template 3: Compliance Mapping

Map each requirement's domain to the controls of any framework the project must meet (for example PCI DSS, HIPAA, GDPR, SOC 2, NIST CSF, ISO 27001, OWASP ASVS). Build a matrix of framework control → requirement ids, then run a gap analysis:

- **Missing control**: a framework control with no requirement covering it
- **Weak coverage**: a framework control covered by only one requirement

Take control ids from the framework's own current document; never guess them.

## Template 4: Security User Story

```markdown
## {id}: {title}

**User Story:**
As a {role},
I want the system to {description},
So that {benefit}.

**Priority:** {priority}
**Type:** {type}
**Domain:** {domain}

**Acceptance Criteria:**
- [ ] {criterion}

**Definition of Done:**
- [ ] Implementation complete
- [ ] Security tests pass
- [ ] Code review complete
- [ ] Security review approved
- [ ] Documentation updated

**Security Test Cases:**
- {test case}

**Traceability:**
- Threats: {threat refs or N/A}
- Compliance: {compliance refs or N/A}
```

Role and benefit by domain:

| Domain | As a | So that |
| --- | --- | --- |
| Authentication | security-conscious user | my identity is protected from impersonation |
| Authorization | system administrator | users can only access resources appropriate to their role |
| Data protection | data owner | my sensitive information remains confidential |
| Audit logging | security analyst | I can investigate security incidents |
| Input validation | application developer | the system is protected from malicious input |
| Other | user | the system is secure |

## Template 5: Security Epic (one per domain)

```markdown
# Security Epic: {Domain}

## Overview
This epic covers all security requirements related to {domain}.

## Business Value
- Protect against {domain} related threats
- Meet compliance requirements
- Reduce security risk

## Stories in this Epic
- [{id}] {title}

## Acceptance Criteria
- All stories complete
- Security tests passing
- Security review approved
- Compliance requirements met

## Risk if Not Implemented
- Vulnerability to {domain} attacks
- Compliance violations
- Potential data breach

## Dependencies
- {dependency or None identified}
```
