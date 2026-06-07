# I built a real outreach tool by writing rules, not code

Last weekend I built a working piece of software — the kind you'd normally
scope as a multi-week project — mostly by **describing what I wanted and setting
clear boundaries**. The AI did the typing. I did the directing.

Here's what came out the other end, and the one habit that made it actually work.

---

## What it does

A local desktop tool for personalized outreach — depth, not spam:

- **Upload your lists** — company info and contacts as CSV or Excel. A smart parser
  figures out messy column names on its own ("Email Id", "Job Title", "Full Name"…
  it just maps them).
- **AI drafts each email** — one genuinely specific message per person, written to a
  strict house style: no buzzwords, no exclamation marks, a real opening line about
  *them*, and a small clear ask.
- **You stay in control** — a review dashboard to approve, edit, regenerate, or skip.
  Keyboard shortcuts so you can fly through it.
- **Sends safely** — through your own email, one at a time, with throttling: working
  hours only, gaps between sends, per-company and daily caps.
- **Tracks everything** — a local timeline of who got what and when, fully searchable.
- **Handles replies and opt-outs** — detects responses, pauses follow-ups, honors
  "STOP" automatically, and adds an opt-out line to every message.

It's not a toy demo. It has a database, tests, error handling, and security baked in.

---

## The "wow": I barely wrote code

I didn't open a blank file and grind. I wrote a **specification** — a plain-English
document describing the product — and handed it over. The build came back in working
chunks I could run and check.

The surprise wasn't that the AI could code. It's that with the right setup, the
result was *organized, consistent, and safe* — not a pile of spaghetti that works once
and breaks forever.

---

## The secret: rules and boundaries

This is the part most people skip, and it's the whole game. "Vibe coding" gets a bad
reputation because people give a vague prompt and accept whatever falls out. Flip that.
Treat the AI like a brilliant new engineer on day one: give it a crisp brief, hard
constraints, and review gates.

A few of the boundaries I set up front — and why each one mattered:

**1. Lock the toolset.**
> "Do not substitute these. Do not add a build step."

No surprise dependencies, no trendy framework swap halfway through. The project stayed
boring and predictable — which is exactly what you want.

**2. Define the shape before any code.**
A folder layout and a database design, written down first. The AI built *into* a
structure instead of inventing a new one every file.

**3. Build in milestones, and stop at each one.**
> "Complete the work, run the verification, and ask before proceeding. Do not skip ahead."

Twelve checkpoints. At each, I ran it myself and confirmed before moving on. Problems
got caught at step 3, not at step 12.

**4. Make safety non-negotiable, in writing.**
Secrets live in a config file that's never committed. All database access is done the
safe way. Inputs are validated. Limits prevent runaway loops. None of this was an
afterthought — it was a rule before line one.

**5. Put guardrails in the *product*, not just the code.**
The throttling, the working-hours window, the suppression list, the automatic opt-out
footer — *"there is no toggle to disable it."* The tool is polite and compliant by
design, because the spec demanded it.

**6. When unsure, ask — don't guess.**
> "If anything is unclear, ask before guessing."

That one line removes 90% of the "the AI confidently did the wrong thing" problem.

---

## Boundaries all the way to shipping

The same discipline carried through to going public. Secrets never touched the
codebase. Before anything was shared, every personal detail was stripped out and the
history cleaned. Rules didn't just shape the build — they shaped what was safe to
release.

---

## The takeaway

You don't need to be a senior engineer to build real things now. But you do need to
think like one for an afternoon: **decide what "good" means, write the rules down, and
hold the line at each step.**

The magic isn't the prompt. It's the boundaries around it.

That's the shift. The people who get the most out of these tools aren't the best
typists — they're the clearest thinkers about what they actually want.

Give it rules. Give it boundaries. Then watch how far it runs.

---

*Built with Claude Code. The hard part wasn't the code — it was deciding the rules.*
