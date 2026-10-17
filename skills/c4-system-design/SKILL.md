---
name: c4-system-design
description: Use when designing or documenting a software system's architecture with the C4 model (Simon Brown): system context, containers, components, deployment and dynamic views, tracing requirements and non-functional needs to architecture elements and decisions.
---

# C4 System Design

Model a software system with the C4 model: a small set of abstractions (people, software systems, containers, components) viewed at increasing levels of zoom. The model is the design; diagrams are views of it. This skill is about what goes into the model and each view, not how to draw it. Any text or diagram notation works if it follows the rules below.

## When to use

- Designing a new system or a major new part of one
- Documenting an existing system so others (or future agents) can reason about it
- Checking whether a set of requirements is actually covered by the architecture
- Explaining where a change lands: which container, which components, which integrations
- Preparing the ground for architecture decisions (see the architecture-decisions skill)

## Core principles

1. **Abstractions first, diagrams second.** Agree what the people, systems, containers and components are before arranging boxes. A diagram that cannot be traced back to a consistent model is a picture, not a design.
2. **One level per view.** Each view answers one question at one zoom level. Never mix containers and components, or components and classes, in the same view.
3. **Every element and every arrow explains itself.** A reader with no other context should understand what each box is, what it does, what it runs on, and why each arrow exists.
4. **Containers are runtime boundaries.** A container is something that must be running (or hold data) for the system to work. Code organisation is not a container.
5. **Stop at the level that earns its keep.** Context and Containers are almost always worth it. Components only for containers that are complex or risky. Code level is usually skipped; the code itself and the IDE show it better.
6. **Requirements drive the model.** Every requirement lands somewhere in the model; every non-functional requirement drives an explicit decision.

## The abstractions

| Element | What it is | Examples |
| --- | --- | --- |
| **Person** | A human user or role that interacts with the system | Customer, Admin, Support agent |
| **Software system** | The highest level: something that delivers value to users, owned and built as a unit. Includes the system being designed and the external systems it depends on | "Billing system", payment provider, email service, identity provider |
| **Container** | A separately runnable or deployable unit inside the software system, or a data store. Executes code or stores data | Single-page web app, mobile app, API server, background worker, CLI, serverless function, relational database, object store bucket, message queue, file system folder of data |
| **Component** | A grouping of related functionality behind a well-defined interface, inside one container. Not separately deployable | Auth module, order service, payment gateway adapter, repository for orders |
| **Code** | Classes, functions, tables that implement a component | Usually not modelled |

"Container" here has nothing to do with Docker. A Docker container usually hosts one C4 container, but the C4 term is about runtime boundaries.

## The views

### Level 1: System Context
Question answered: **what is this system, who uses it, and what does it depend on?**
- The system in scope as one box in the middle
- People who use it
- External software systems it talks to (and that talk to it)
- No technology detail, no internals
- Audience: anyone, including non-technical people

### Level 2: Containers
Question answered: **what are the runnable/deployable pieces and data stores, what technology are they, and how do they communicate?**
- Every container inside the system boundary, with its technology
- People and external systems from Level 1 that connect to specific containers
- Relationships with protocol or mechanism (HTTPS/JSON, gRPC, SQL over TCP, AMQP, reads/writes files)
- Audience: technical people, including the builders and operators

### Level 3: Components
Question answered: **how is one container structured internally?**
- One diagram per container that deserves it
- Components inside that container, plus the containers, people and external systems they talk to
- Relationships between components (calls, publishes, reads)
- Draw only for containers that are complex, risky, or shared by many changes

### Level 4: Code
Usually skipped. If needed, only for one critical or intricate component, and preferably generated from code rather than maintained by hand.

### Supplementary views
- **System Landscape**: all software systems and people in an organisation or product family. Useful when there are several systems in play.
- **Dynamic**: how elements collaborate at runtime for one use case or feature. Numbered interactions in order (1, 2, 3...), each with what is sent or asked. Use for the key flows: sign-up, checkout, data sync, the flow behind a critical requirement.
- **Deployment**: how container instances map onto infrastructure in one environment (production, staging, local). Deployment nodes nest (cloud region → cluster → node → runtime), containers are placed as instances, and infrastructure nodes (load balancers, DNS, firewalls, CDNs) appear where they matter. One deployment view per environment that differs meaningfully.

## Notation rules (tool-agnostic)

Every **element** states:
- **Name**
- **Type**: person, software system, container, component (and external vs internal)
- **Technology**: for containers and components (e.g. "TypeScript, Next.js", "PostgreSQL 16", "Python worker on a queue"). Not used for people; optional for external systems
- **Responsibility**: one line, what it does ("Stores orders, customers and invoices", "Sends transactional email")

Every **relationship**:
- Is one-directional and labelled with **intent**, read from source to target ("Places orders using", "Reads and writes order data", "Sends password reset emails via")
- At container level and below, also states **technology/protocol** ("HTTPS/JSON", "SQL/TCP", "AMQP", "webhook HTTPS POST")
- Shows the direction of the dependency or call, not the direction of data alone. If both directions matter, use two relationships

Every **view** has:
- A title stating the type and scope ("Container view: Billing system")
- A key/legend explaining shapes, colours, line styles and borders, if any are used
- The system boundary drawn or stated where it applies

Use a consistent visual or textual vocabulary across all views. See `references/c4-templates.md` for text templates of each view and the element catalogue.

## Choosing container boundaries

Something is a separate container when at least one of these holds:
- It is deployed or started separately (its own process, app, function, or binary)
- It runs in a different place (browser vs server, device vs cloud)
- It stores data (each database, bucket, queue or cache is its own container)
- It scales, fails or is released independently

Something is **not** a container when:
- It is a library, package, framework or module linked into another process. That is a component, or not modelled at all
- It is a folder or layer in the codebase (controllers, services, utils)
- It is infrastructure that does not run your code or hold your data (load balancer, DNS). Those belong in the deployment view

Guidance:
- A monolith is one container plus its data stores; that is a valid, often correct, design
- A browser SPA and the API that serves it are two containers, even if they live in one repo
- A shared database used by two containers is one container with two relationships, and it is a coupling worth stating
- Third-party SaaS is an external software system, not a container of yours

## Method

1. **Gather the inputs.** Requirements (functional and non-functional), users and roles, external systems, constraints (budget, team skills, hosting, compliance), and any existing system. List open questions instead of guessing.
2. **Draft the System Context.** Name the system, list people and external systems, and label each relationship with intent. Confirm scope: what is inside the boundary and what is not.
3. **Draft the Containers.** Decide the runnable units and data stores using the boundary rules. For each, pick technology and write the one-line responsibility. Add relationships with protocols. Prefer fewer containers; each extra one must be justified by a requirement or constraint.
4. **Trace requirements.** Build a traceability table: each functional requirement → the containers (and components) that fulfil it. Each non-functional requirement (performance, availability, security, privacy, cost, operability) → the decision and the elements it shapes. A requirement with no home is a gap; an element with no requirement is a candidate for removal.
5. **Draw dynamic views for the critical flows.** Walk the top 2–5 use cases through the containers step by step. This is where missing relationships, chatty calls and wrong boundaries show up.
6. **Zoom into components where it pays.** For each complex or risky container, list components, their responsibilities and interfaces, and their relationships to other containers.
7. **Add deployment notes.** At minimum: where each container runs, how it is scaled, where data lives, and environment differences. Draw a deployment view when hosting is non-trivial.
8. **Record decisions.** For each significant choice made along the way, write an ADR (see "When to write an ADR").
9. **Iterate.** When requirements change, update the model first, re-run the traceability check, then update the affected views. Note what changed and why.

## Requirements traceability

| Requirement | Kind | Elements | Decision / note |
| --- | --- | --- | --- |
| Users can reset their password by email | Functional | Web app, API, Email service (external) | Reset tokens single-use, 30 min expiry |
| p95 page load under 1 s for catalog | NFR: performance | Web app, API, Cache | Cache catalog reads; ADR-0004 |
| Customer data stays in the EU | NFR: compliance | Database, Object store, Deployment (EU region) | Region pinned; ADR-0002 |

Check: every requirement has at least one element; every NFR has a decision; every container appears at least once.

## When to write an ADR

Write one (see the architecture-decisions skill) when a choice is significant and hard to reverse, for example:
- Splitting or merging containers (monolith vs separate services, adding a worker or queue)
- Choosing a data store, a hosting platform, a framework or a language for a container
- Choosing a communication style between containers (sync HTTP vs messaging, polling vs webhooks)
- An NFR drives an architectural constraint (data residency, offline support, multi-tenancy, encryption)
- Adopting or dropping an external system (identity provider, payments, search)

Do not write one for choices local to one component that are easy to change. Reference ADR ids from the traceability table and from the elements they shape.

## Common mistakes

- **Mixing levels**: components drawn in the container view, or classes in a component view
- **Unlabelled or vague arrows**: "uses", "calls", bare lines, or no protocol at container level
- **Missing technology or responsibility** on containers, leaving readers to guess
- **Libraries shown as containers**: an ORM, a UI kit or a logging library is not a container
- **Microservice soup**: many tiny containers with no requirement that justifies the split, chatty synchronous chains, shared databases hidden behind "independent" services
- **Codebase structure presented as architecture**: folders and layers in place of runtime units
- **Infrastructure mixed into logical views**: load balancers and VPCs in the container view instead of the deployment view
- **No system boundary**: unclear what is yours and what is external
- **Bidirectional arrows** that hide which side depends on which
- **Diagrams that drift** from the model or the code because they were edited in isolation
- **Overdesign for the stage**: Kubernetes, event buses and many services for a product with one developer and few users

## Done means

- System Context and Container views exist, with every element named, typed, with technology (containers) and a one-line responsibility
- Every relationship is labelled with intent, plus protocol at container level
- Component views exist only for containers that needed them
- Dynamic views cover the critical flows; deployment is described for each meaningful environment
- The traceability table maps every requirement to elements and every NFR to a decision
- Significant decisions have ADRs, referenced from the model
- Open questions and assumptions are listed, not buried
- A reader new to the project can explain, from the views alone, what runs where and how a key request flows through the system
