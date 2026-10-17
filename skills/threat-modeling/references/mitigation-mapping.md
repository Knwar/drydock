# Threat-mitigation mapping — templates and worked examples

## Template 1: Mitigation Model

**Security control** fields: id, name, description, control type (preventive / detective / corrective), layer (network, application, data, endpoint, process, physical), effectiveness (None 0, Low 1, Medium 2, High 3, Very high 4), implementation cost and maintenance cost (Low / Medium / High), status, threats it mitigates, dependencies, technologies.

**Implementation status** and its multiplier:

| Status | Multiplier |
| --- | --- |
| Not implemented | 0.0 |
| Partial | 0.5 |
| Implemented | 0.8 |
| Verified | 1.0 |

**Control coverage score** = effectiveness × status multiplier (0–4).

**Threat coverage %** = (sum of coverage scores of the threat's controls) ÷ (number of those controls × 4) × 100. A threat with no controls has 0% coverage.

**Mapping record** per threat: the threat, its controls, residual risk, notes.

Gap checks per threat (see the gap rules in SKILL.md): unmapped, coverage < 50%, fewer than 2 layers among controls that are not "not implemented", fewer than 2 control types among those controls.

## Template 2: Control Library

A starter set of standard controls (examples of technologies, not endorsements):

| Id | Control | Type | Layer | Effectiveness | Impl. cost | Maint. cost | Mitigates | Technologies |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AUTH-001 | Multi-factor authentication: require MFA for all user authentication | Preventive | Application | High | Medium | Low | Spoofing | TOTP, WebAuthn, SMS OTP |
| AUTH-002 | Account lockout policy: lock accounts after failed authentication attempts | Preventive | Application | Medium | Low | Low | Spoofing | Custom implementation |
| VAL-001 | Input validation framework: validate and sanitize all user input | Preventive | Application | High | Medium | Medium | Tampering, injection | Joi, Yup, Pydantic |
| VAL-002 | Web application firewall: filter malicious requests | Preventive | Network | Medium | Medium | Medium | Tampering, injection, DoS | AWS WAF, Cloudflare, ModSecurity |
| ENC-001 | Data encryption at rest: encrypt sensitive data in storage | Preventive | Data | High | Medium | Low | Information disclosure | AES-256, KMS, HSM |
| ENC-002 | TLS encryption: encrypt data in transit using TLS 1.3 | Preventive | Network | High | Low | Low | Information disclosure, tampering | TLS 1.3, certificate management |
| LOG-001 | Security event logging: log all security-relevant events | Detective | Application | Medium | Low | Medium | Repudiation | ELK Stack, Splunk, CloudWatch |
| LOG-002 | Log integrity protection: protect logs from tampering | Preventive | Data | Medium | Medium | Low | Repudiation, tampering | Immutable storage, log signing |
| ACC-001 | Role-based access control: implement RBAC for authorization | Preventive | Application | High | Medium | Medium | Elevation of privilege, information disclosure | RBAC, ABAC, policy engines |
| AVL-001 | Rate limiting: limit request rates to prevent abuse | Preventive | Application | Medium | Low | Low | Denial of service | API gateway, Redis, token bucket |
| AVL-002 | DDoS protection: deploy DDoS mitigation services | Preventive | Network | High | High | Medium | Denial of service | Cloudflare, AWS Shield, Akamai |

To recommend controls for a threat: take the library controls whose "Mitigates" includes the threat's category, minus the ones already in place.

## Template 3: Mitigation Analysis

**Overall risk reduction %** = Σ(threat risk score × threat coverage %) ÷ Σ(threat risk scores), over all mapped threats.

**Critical gaps** = gaps on threats whose impact is Critical.

**Choosing controls within a budget** (greedy): for each not-yet-implemented control whose cost fits the remaining budget, value = (number of unmapped threats it covers × effectiveness) ÷ cost. Sort by value, highest first, and take controls while the budget lasts.

**Roadmap**:
- Phase 1: not-yet-implemented controls for gaps on Critical-impact threats (top 5).
- Phase 2: the same for High-impact threats (top 5).

**Defense in depth analysis**: list, per layer, the controls that are implemented or verified. Every empty layer is a recommendation ("Add <layer> layer controls"); any "no control diversity" gap means "Add more detective and corrective controls".

### Mitigation report template

```markdown
# Threat Mitigation Report

## Executive Summary
- **Overall Risk Reduction:** {x}%
- **Total Threats:** {n}
- **Total Controls:** {n}
- **Identified Gaps:** {n}
- **Critical Gaps:** {n}

## Defense in Depth Coverage
- {layer}: covered / not covered ({n} controls)

## Critical Gaps Requiring Immediate Action
- **{threat name}**: {issue}
  - Coverage: {x}%
  - Recommendation: {recommendation}

## Recommendations
- {recommendation}

## Implementation Roadmap

### Phase 1
- [Critical] {control name} (for {threat id})

### Phase 2
- [High] {control name} (for {threat id})
```

## Template 4: Control Effectiveness Testing

For each control, define tests (control id, test name, description, expected result). Run them, record pass/fail and any error. **Control effectiveness %** = passed tests ÷ tests for that control × 100.

```markdown
# Control Effectiveness Test Report

## Summary
- **Total Tests:** {n}
- **Passed:** {n}
- **Failed:** {n}
- **Pass Rate:** {x}%

## Results by Control

### {control id} (Effectiveness: {x}%)
- PASS {test name}
- FAIL {test name}
  - Error: {error}
```
