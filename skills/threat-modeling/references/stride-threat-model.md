# STRIDE threat model — templates and worked examples

## Template 1: STRIDE Threat Model Document

~~~markdown
# Threat Model: [System Name]

## 1. System Overview

### 1.1 Description

[Brief description of the system and its purpose]

### 1.2 Data Flow Diagram

```
[User] --> [Web App] --> [API Gateway] --> [Backend Services]
                                  |
                                  v
                             [Database]
```

### 1.3 Trust Boundaries
- **External Boundary**: Internet to DMZ
- **Internal Boundary**: DMZ to Internal Network
- **Data Boundary**: Application to Database

## 2. Assets

| Asset | Sensitivity | Description |
|-------|-------------|-------------|
| User Credentials | High | Authentication tokens, passwords |
| Personal Data | High | PII, financial information |
| Session Data | Medium | Active user sessions |
| Application Logs | Medium | System activity records |
| Configuration | High | System settings, secrets |

## 3. STRIDE Analysis

### 3.1 Spoofing Threats

| ID | Threat | Target | Impact | Likelihood |
|----|--------|--------|--------|------------|
| S1 | Session hijacking | User sessions | High | Medium |
| S2 | Token forgery | JWT tokens | High | Low |
| S3 | Credential stuffing | Login endpoint | High | High |

**Mitigations:**
- [ ] Implement MFA
- [ ] Use secure session management
- [ ] Implement account lockout policies

### 3.2 Tampering Threats

| ID | Threat | Target | Impact | Likelihood |
|----|--------|--------|--------|------------|
| T1 | SQL injection | Database queries | Critical | Medium |
| T2 | Parameter manipulation | API requests | High | High |
| T3 | File upload abuse | File storage | High | Medium |

**Mitigations:**
- [ ] Input validation on all endpoints
- [ ] Parameterized queries
- [ ] File type validation

### 3.3 Repudiation Threats

| ID | Threat | Target | Impact | Likelihood |
|----|--------|--------|--------|------------|
| R1 | Transaction denial | Financial ops | High | Medium |
| R2 | Access log tampering | Audit logs | Medium | Low |
| R3 | Action attribution | User actions | Medium | Medium |

**Mitigations:**
- [ ] Comprehensive audit logging
- [ ] Log integrity protection
- [ ] Digital signatures for critical actions

### 3.4 Information Disclosure Threats

| ID | Threat | Target | Impact | Likelihood |
|----|--------|--------|--------|------------|
| I1 | Data breach | User PII | Critical | Medium |
| I2 | Error message leakage | System info | Low | High |
| I3 | Insecure transmission | Network traffic | High | Medium |

**Mitigations:**
- [ ] Encryption at rest and in transit
- [ ] Sanitize error messages
- [ ] Implement TLS 1.3

### 3.5 Denial of Service Threats

| ID | Threat | Target | Impact | Likelihood |
|----|--------|--------|--------|------------|
| D1 | Resource exhaustion | API servers | High | High |
| D2 | Database overload | Database | Critical | Medium |
| D3 | Bandwidth saturation | Network | High | Medium |

**Mitigations:**
- [ ] Rate limiting
- [ ] Auto-scaling
- [ ] DDoS protection

### 3.6 Elevation of Privilege Threats

| ID | Threat | Target | Impact | Likelihood |
|----|--------|--------|--------|------------|
| E1 | IDOR vulnerabilities | User resources | High | High |
| E2 | Role manipulation | Admin access | Critical | Low |
| E3 | JWT claim tampering | Authorization | High | Medium |

**Mitigations:**
- [ ] Proper authorization checks
- [ ] Principle of least privilege
- [ ] Server-side role validation

## 4. Risk Assessment

### 4.1 Risk Matrix


```
              IMPACT
         Low  Med  High Crit
    Low   1    2    3    4
L   Med   2    4    6    8
I   High  3    6    9   12
K   Crit  4    8   12   16
```

### 4.2 Prioritized Risks

| Rank | Threat | Risk Score | Priority |
|------|--------|------------|----------|
| 1 | SQL Injection (T1) | 12 | Critical |
| 2 | IDOR (E1) | 9 | High |
| 3 | Credential Stuffing (S3) | 9 | High |
| 4 | Data Breach (I1) | 8 | High |

## 5. Recommendations

### Immediate Actions
1. Implement input validation framework
2. Add rate limiting to authentication endpoints
3. Enable comprehensive audit logging

### Short-term (30 days)
1. Deploy WAF with OWASP ruleset
2. Implement MFA for sensitive operations
3. Encrypt all PII at rest

### Long-term (90 days)
1. Security awareness training
2. Penetration testing
3. Bug bounty program
~~~

## STRIDE Question List

Ask these for each component.

**Spoofing**
- Can an attacker impersonate a legitimate user?
- Are authentication tokens properly validated?
- Can session identifiers be predicted or stolen?
- Is multi-factor authentication available?

**Tampering**
- Can data be modified in transit?
- Can data be modified at rest?
- Are input validation controls sufficient?
- Can an attacker manipulate application logic?

**Repudiation**
- Are all security-relevant actions logged?
- Can logs be tampered with?
- Is there sufficient attribution for actions?
- Are timestamps reliable and synchronized?

**Information Disclosure**
- Is sensitive data encrypted at rest?
- Is sensitive data encrypted in transit?
- Can error messages reveal sensitive information?
- Are access controls properly enforced?

**Denial of Service**
- Are rate limits implemented?
- Can resources be exhausted by malicious input?
- Is there protection against amplification attacks?
- Are there single points of failure?

**Elevation of Privilege**
- Are authorization checks performed consistently?
- Can users access other users' resources?
- Can privilege escalation occur through parameter manipulation?
- Is the principle of least privilege followed?

## Common Mitigations per Category

| Category | Mitigations |
| --- | --- |
| Spoofing | Multi-factor authentication; secure session management; account lockout policies; cryptographically secure tokens; validate authentication at every request |
| Tampering | Input validation; parameterized queries; integrity checks (HMAC, signatures); Content Security Policy; immutable infrastructure |
| Repudiation | Comprehensive audit logging; protect log integrity; digital signatures; centralized, tamper-evident logging; accurate timestamps |
| Information Disclosure | Encrypt data at rest and in transit; proper access controls; sanitize error messages; secure defaults; data classification |
| Denial of Service | Rate limiting; auto-scaling; DDoS protection; circuit breakers; resource quotas |
| Elevation of Privilege | Proper authorization; least privilege; validate permissions server-side; role-based access control; security boundaries |

## STRIDE per Interaction

Apply STRIDE to each interaction (source → target, action, data, protocol) according to the element types involved:

| Interaction | Threats |
| --- | --- |
| External entity → process | **S** external entity spoofing identity to process; **T** tampering with data sent to process; **R** external entity denying sending data; **I** data exposure during transmission; **D** flooding process with requests; **E** exploiting process to gain privileges |
| Process → data store | **T** process tampering with stored data; **R** process denying data modifications; **I** unauthorized data access by process; **D** process exhausting storage resources |
| Process → process | **S** process spoofing another process; **T** tampering with inter-process data; **I** data leakage between processes; **D** one process overwhelming another; **E** process gaining elevated access |
