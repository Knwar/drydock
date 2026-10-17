# Triage Decision Framework: Take It / Worth Considering / Pass / Flag

Adapted from the inbox-triage skill in alirezarezvani/claude-skills (MIT). For each email that asks the user to decide something (a request, pitch, proposal, invitation, collaboration ask), pick one of four categories and match the draft tone to it.

## The four categories

| Category | When | Draft tone | User effort |
|---|---|---|---|
| **Take it** | All of the user's "yes" signals match | Engaged + concrete next step | Read + send (or edit lightly) |
| **Worth considering** | Partial match | Curious + 1-2 clarifying questions | Reply with judgment |
| **Pass** | Any of the user's deal-breakers matches | Polite decline + brief reason | Skim + send |
| **Flag for review** | Unusual, ambiguous, or VIP edge case | No draft; the user decides the shape | Compose from scratch |

## Decision flow

```
For each request or opportunity:
  1. Is the sender someone the user treats as a VIP?  -> Take it (bypass other checks)
  2. Any deal-breaker matches?                         -> Pass
  3. All "yes" signals match?                          -> Take it
  4. Partial match?                                    -> Worth considering
  5. Unusual / unfamiliar shape?                       -> Flag for review
```

The signals come from the user: what they always say yes to, what they always decline, and who always gets serious attention. If the user hasn't told you, ask once and remember the answer; don't invent a framework on the fly. Until then, draft a short acknowledgment and flag.

## Draft tone per category

**Take it: engaged + concrete next step.** Acknowledge what's interesting, name the next step ("happy to do a 30-minute call this week"), include availability or pricing if the user has given it. Same voice register as usual. Anti-pattern: a take-it draft that hedges or asks questions. If the criteria match, commit.

**Worth considering: curious + 1-2 clarifying questions.** Acknowledge interest tentatively, ask 1-2 specific questions that resolve the ambiguity, don't commit to a next step yet, no "I'll think about it". Anti-pattern: 5+ questions. If you need that much, it's a flag.

**Pass: polite decline + brief reason.** Brief, a specific reason ("the timeline doesn't match my current capacity"), no false promises ("circle back next quarter" only if true), no apology ladder. Anti-pattern: inviting back-and-forth ("happy to revisit if budget changes!"). Decline cleanly.

**Flag for review: no draft, surface fully.** Give sender, subject, why flagged, and context; no draft body. Flag when:
- The sender is a public figure (reputation risk on default tone)
- The email contains threats or legal language
- The request is outside anything the user has told you how to handle
- Signals conflict (VIP sender + deal-breaker)
- Anything that would benefit from the user's own voice rather than a templated one

## Other email types

| Type | Default action |
|---|---|
| Active conversations | Draft a reply matching the thread's tone |
| Action required | Draft a reply, or flag if the action is unclear |
| Financial | Never draft; always flag (financial decisions are the user's) |
| Important / personal | Draft if the pattern is clear; flag otherwise |
| Informational | No draft (FYI emails don't need replies) |
| Ignore / low priority | Skip |

## VIP override

VIP senders bypass pass filters but not flag logic. A VIP with an unusual request is still flagged. The bypass means "always gets serious consideration", not "always gets an auto-draft with no judgment".

## Anti-patterns

- Auto-drafting flag cases
- Hedging in pass drafts
- 5+ questions in worth-considering drafts
- Take it with conditions (that's worth considering)
- Classifying a VIP as pass
- Drafting for financial emails
