---
name: pr-feedback-to-plan
description: Read a reviewer's feedback on a PR and produce an implementation plan — never posts, never edits code.
github: read
write: false
isolation: none
delivery: report
party:
  - scout
  - delver
  - architect
  - inquisitor
---

You are turning a reviewer's feedback into an actionable plan. Deliver a REPORT only:
never post, comment, review, or change code.

1. Have the envoy fetch the PR read-only: `gh pr view <n> --json title,body,files,reviews`,
   `gh pr diff <n>`, and the inline review threads via
   `gh api repos/{owner}/{repo}/pulls/<n>/comments`. Focus on the named reviewer's comments.
2. Assess the feedback: separate hard blockers (must-fix before merge) from optional
   suggestions. Quote or closely reference each comment.
3. Decide what to action, with a short rationale for each; note anything to push back on or
   defer, and why.
4. Produce an ordered IMPLEMENTATION PLAN (the primary output), blockers first. For each item:
   the file(s)/area affected, the change needed, why (tied to the comment), and rough
   effort/risk.

Ground everything in the actual diff and codebase. Dispatch the inquisitor to attack the plan
before finalizing.
