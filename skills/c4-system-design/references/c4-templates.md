# C4 text templates

Plain-text templates for each view. They carry the same content as a diagram and can be turned into one with any notation. Replace everything in angle brackets.

## Element catalogue

One catalogue for the whole model; views pick elements from it.

| Id | Name | Type | Internal / external | Technology | Responsibility |
| --- | --- | --- | --- | --- | --- |
| P1 | Customer | Person | External | – | Browses catalog and places orders |
| S1 | Shop | Software system | Internal | – | Sells products online |
| S2 | Payment provider | Software system | External | <vendor> | Takes card payments |
| C1 | Web app | Container | Internal | <TypeScript, React SPA> | Catalog, cart and checkout UI in the browser |
| C2 | API | Container | Internal | <Node.js, Express> | Business logic and JSON API |
| C3 | Database | Container (data store) | Internal | <PostgreSQL> | Stores products, orders, customers |
| K1 | Order service | Component (in C2) | Internal | <TypeScript module> | Creates and updates orders |

## Relationship list

| From | To | Intent | Technology / protocol |
| --- | --- | --- | --- |
| P1 | C1 | Browses and orders using | HTTPS |
| C1 | C2 | Makes API calls to | HTTPS/JSON |
| C2 | C3 | Reads and writes data in | SQL/TCP |
| C2 | S2 | Creates payment intents using | HTTPS/JSON |
| S2 | C2 | Sends payment result webhooks to | HTTPS POST |

## System Context view

```
Title: System Context view: <system>
Scope: <system> (internal)

People:
- <name>: <role and what they do with the system>

External systems:
- <name>: <what it does for us>

Relationships:
- <person/system> → <system>: <intent>
- <system> → <external system>: <intent>

Out of scope: <things deliberately outside the boundary>
```

## Container view

```
Title: Container view: <system>
Boundary: <system>

Containers:
- <name> [<technology>]: <responsibility>
- <data store name> [<technology>]: <what data it holds>

Outside the boundary:
- <person / external system>

Relationships:
- <from> → <to>: <intent> [<protocol>]

Key: <shapes/colours/line styles, if used>
```

## Component view

```
Title: Component view: <system> / <container>
Boundary: <container>

Components:
- <name> [<technology>]: <responsibility>; interface: <what it exposes>

Neighbours (outside the container):
- <container / external system / person>

Relationships:
- <from> → <to>: <intent> [<mechanism: call, event, query>]
```

## Dynamic view

```
Title: Dynamic view: <use case> (<system or container> scope)

1. <from> → <to>: <what is sent or asked> [<protocol>]
2. <from> → <to>: <...>
3. ...

Failure paths: <what happens if step N fails>
Notes: <timeouts, retries, idempotency, consistency>
```

## Deployment view

```
Title: Deployment view: <system> – <environment>

Deployment nodes:
- <cloud / provider> [<region>]
  - <node, e.g. container platform, VM, managed service> [<technology>]
    - Container instance: <container> x<count>
  - <managed database> [<technology, tier>]
    - Container instance: <data store>

Infrastructure nodes:
- <load balancer / CDN / DNS / firewall>: <role>

Notes:
- Scaling: <how each container scales>
- Data location and backups: <...>
- Differences from other environments: <...>
```

## Requirements traceability

| Requirement | Kind | Elements | Decision / ADR |
| --- | --- | --- | --- |
| <requirement> | Functional / NFR: <quality> | <element ids> | <decision, ADR id> |

## Review checklist

- [ ] Each view has a title, scope and (if styling is used) a key
- [ ] No view mixes levels
- [ ] Every element: name, type, technology (containers/components), one-line responsibility
- [ ] Every relationship: direction, intent, protocol at container level and below
- [ ] Every data store is its own container
- [ ] No libraries or code folders shown as containers
- [ ] Every requirement traced; every NFR has a decision
- [ ] Significant decisions have ADRs
