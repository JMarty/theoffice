---
name: clear-agent-modal-safely
description: Unstick an agent frozen on a Claude Code modal (usage-limit, permission/approval, dangerous-op gate) WITHOUT risking a spend or a destructive action. Use whenever a pane is parked on a prompt, an agent has gone silent, or the frozen-pane alarm fires. Never send a bare Enter to a modal.
---
# Clear an agent modal safely

## When to use
- frozen-pane-alarm fires, or an agent has gone quiet mid-task
- A pane is parked on any modal: usage-limit, "Do you want to proceed?", a permission/approval gate
- You are tempted to "just press Enter to unstick it". That is the moment this skill exists for.

## The one rule
**A bare Enter is never safe.** Enter selects whatever the cursor `❯` is currently on, and you do
not know where that is until you LOOK. Observed live 2026-08-04: a dangerous-`rm` gate on agent-cfo
had the cursor sitting on **"1. Yes"**. Enter would have run `rm "$WORK"/*.pdf` with a possibly-empty
`$WORK` on the owner's box. On a usage-limit modal the same mistake selects "Upgrade" and charges the
owner's card.

"Avoid pressing the digit" does NOT make Enter safe. Safety comes from VERIFYING THE HIGHLIGHT.

## Procedure
1. **Read the pane first. Never act blind.**
   `tmux -L theoffice capture-pane -p -t agent-<name> | tail -15`
2. **Classify what you are looking at:**
   - *Usage-limit / resume-summary* -> safe to dismiss (choose "Stop and wait…")
   - *Permission / approval / dangerous-op* ("Do you want to proceed?", "make this edit", "Yes, and don't ask again")
     -> **DETECT AND ALARM ONLY by default.** Clearing it blind = blind-approving an action
     (delete/push/payment/deploy) using the owner's credentials. Freezing is the SAFE failure.
   - Only proceed to step 3 if you have READ the exact operation and know which option is correct.
3. **Move the cursor to the option you actually want** (`Down` / `Up`). This alone confirms nothing.
   `tmux -L theoffice send-keys -t agent-<name> Down`
4. **CAPTURE THE PANE AGAIN and prove the highlight moved** to the intended line before any confirm:
   `tmux -L theoffice capture-pane -p -t agent-<name> | tail -8`   # expect `❯ 2. No`
5. **Only now press Enter.** `tmux -L theoffice send-keys -t agent-<name> Enter`
6. **Verify the outcome** — re-capture. Confirm the modal is gone and the pane did not re-enter it
   (otherwise a sweeper will loop on it every cycle).
7. **The turn usually ENDS after a decline.** The agent goes idle; it does NOT auto-resume. Send it a
   bus message telling it what happened and to restart the work.

## Choosing the answer on a dangerous-op gate
Default to **No**. Declining is safe in every case and grants nothing; approving is unbounded.
For `rm` with an interpolated variable, fix the script rather than approving it:
```bash
WORK=$(mktemp -d) || exit 1
[ -n "$WORK" ] && [ -d "$WORK" ] || exit 1
trap 'rm -rf -- "$WORK"' EXIT     # no bare rm anywhere
```

## Pitfalls
- Agents **DO** hit permission gates despite `--dangerously-skip-permissions`. Claude Code still
  surfaces ops it deems dangerous. Do not assume skip-permissions means no prompts.
- An agent can sit frozen for HOURS with nobody noticing (cfo: 2h40m, mid an owner-facing task).
  Delivery to that pane is gated shut, so inbound parks with attempts=0 and never alarms on its own.
- The permission alarm routing through a single relay agent is a SPOF: if the relay is itself frozen,
  the alarm goes nowhere. Dangerous-op gates should reach the owner directly.
- Do not let an automated sweeper handle permission prompts. Detection without action is strictly
  safer; only the exact usage-limit signature with the cursor provably on the safe option may be
  auto-dismissed.

## Break-glass sweeper (emergency only — the engine normally owns this)
The live path for usage-limit dismissal is the IN-ENGINE session-hygiene sweeper (theoffice.service,
`src/session/modal-sweeper.ts`): highlight-verified Stop-and-wait dismissal PLUS permission/dangerous-op
alarm, owner-direct. It runs automatically on a ~20s tick — you should not normally need a standalone tool.

A RETIRED standalone fallback is kept on disk at `tools/modal-sweeper/modal_sweeper.py` (out of git;
its timer was disabled 2026-08-04 when the in-engine sweeper superseded it). Use it ONLY if the
in-engine sweeper itself has to be disabled and usage-limit modals start piling up. Before running it:
**re-verify its frame matchers against a live pane** (Claude Code's rendering drifts and the matchers may
be stale), run it ONCE by hand, and **never re-enable its timer** — two sweepers double-actuate the same
modal. Like this skill, it only ever confirms the Stop-and-wait line and refuses every other frame.

## Verification
- Before Enter: the capture from step 4 literally shows `❯` on the intended option.
- After Enter: modal gone, nothing destructive ran, and the agent was explicitly told to resume.
